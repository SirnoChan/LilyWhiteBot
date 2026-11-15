/*
 * database.js SQLite 持久層
 *
 * 管理三類數據：
 * 1. bridge_map  —— 跨平台回復/撤回的消息映射（24 小時 TTL）
 * 2. uploads     —— 上傳到對象存儲的文件記錄（到期自動刪除）
 * 3. message_log —— 互联群組消息記錄（含插件來源標記，供 AI 上下文跨重啟恢復，14 天 TTL）
 *
 * 數據庫文件：data/lilywhite.db（SQLite，無需外部服務）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const winston = require('winston');

let db = null;
let s3Config = null;   // { endpoint, region, bucket, accessKeyId, secretAccessKey, keyPrefix }

const init = (dataDir, s3 = null) => {
    // Node 22.13+ 內置 node:sqlite（穩定），無需外部依賴。
    // Node 22.5-22.12 需要 --experimental-sqlite 運行參數。
    const { DatabaseSync } = require('node:sqlite');
    const dbFile = process.env.LWB_DB_MEMORY === '1' ? ':memory:' : path.join(dataDir, 'lilywhite.db');
    if (dbFile !== ':memory:') {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    db = new DatabaseSync(dbFile);
    db.exec('PRAGMA journal_mode = WAL');

    db.exec(`
        CREATE TABLE IF NOT EXISTS bridge_map (
            map_key       TEXT PRIMARY KEY,
            source_client TEXT NOT NULL,
            source_id     TEXT NOT NULL,
            source_chat   TEXT,
            target_client TEXT NOT NULL,
            target_id     TEXT NOT NULL,
            target_chat   TEXT,
            created_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_bridge_map_forward ON bridge_map(source_client, source_id);
        CREATE INDEX IF NOT EXISTS idx_bridge_map_target  ON bridge_map(target_client, target_id);
        CREATE INDEX IF NOT EXISTS idx_bridge_map_created ON bridge_map(created_at);

        CREATE TABLE IF NOT EXISTS uploads (
            object_key TEXT PRIMARY KEY,
            url        TEXT NOT NULL,
            size       INTEGER,
            created_at INTEGER NOT NULL,
            expiry_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_uploads_expiry ON uploads(expiry_at);

        CREATE TABLE IF NOT EXISTS message_log (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at INTEGER NOT NULL,
            to_uid     TEXT NOT NULL,
            from_uid   TEXT,
            nick       TEXT,
            text       TEXT,
            source     TEXT NOT NULL DEFAULT 'user',
            client     TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_msglog_chat    ON message_log(to_uid, id);
        CREATE INDEX IF NOT EXISTS idx_msglog_created ON message_log(created_at);
    `);
    // 每行可帶獨立 TTL（毫秒）；NULL = 默認 24h。AI 回復等長壽映射用 7 天。
    try {
        db.exec('ALTER TABLE bridge_map ADD COLUMN ttl INTEGER');
    } catch (e) { /* 列已存在 */ }

    // 每小時清理：過期 bridge_map 與超過保留期的 message_log
    setInterval(() => {
        try { cleanupBridgeMap(); } catch (e) { /* 忽略 */ }
        try { purgeOldMessages(); } catch (e) { /* 忽略 */ }
    }, 3600 * 1000).unref();

    if (s3) {
        s3Config = s3;
        // 每小時清理到期文件
        setInterval(() => {
            cleanupExpiredUploads().catch(e => winston.warn(`[database] upload cleanup failed: ${e.message}`));
        }, 3600 * 1000).unref();
    }
};

/* ---------------- bridge_map ---------------- */

const rememberSent = (sourceClient, sourceId, sourceChat, targetClient, sentIds, ttlMs = null) => {
    const now = Date.now();
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO bridge_map (map_key, source_client, source_id, source_chat, target_client, target_id, target_chat, created_at, ttl)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const s of sentIds) {
        if (s && s.id !== undefined) {
            const chat = s.chat !== undefined ? s.chat : (s.channel !== undefined ? s.channel : s.room);
            stmt.run(`${sourceClient}|${sourceId}|${targetClient}`, sourceClient, String(sourceId), sourceChat !== undefined ? String(sourceChat) : null, targetClient, String(s.id), chat !== undefined ? String(chat) : null, now, ttlMs);
        }
    }
    globalThis.__lwbDb = db;
};

const lookupForward = (sourceClient, sourceId, sourceChat) => {
    const rows = sourceChat !== undefined
        ? db.prepare(`
            SELECT target_client, target_id, target_chat FROM bridge_map
            WHERE source_client = ? AND source_id = ? AND source_chat = ? AND created_at + COALESCE(ttl, 86400000) > ?
        `).all(String(sourceClient), String(sourceId), String(sourceChat), Date.now())
        : db.prepare(`
            SELECT target_client, target_id, target_chat FROM bridge_map
            WHERE source_client = ? AND source_id = ? AND created_at + COALESCE(ttl, 86400000) > ?
        `).all(String(sourceClient), String(sourceId), Date.now());
    return rows.length ? rows : null;
};

const lookupByForwardId = (targetClient, botMsgId, targetChat) => {
    const rows = targetChat !== undefined
        ? db.prepare(`
            SELECT source_client, source_id, source_chat FROM bridge_map
            WHERE target_client = ? AND target_id = ? AND target_chat = ? AND created_at + COALESCE(ttl, 86400000) > ?
        `).all(String(targetClient), String(botMsgId), String(targetChat), Date.now())
        : db.prepare(`
            SELECT source_client, source_id, source_chat FROM bridge_map
            WHERE target_client = ? AND target_id = ? AND created_at + COALESCE(ttl, 86400000) > ?
        `).all(String(targetClient), String(botMsgId), Date.now());
    return rows.length ? rows : null;
};

const cleanupBridgeMap = () => {
    const info = db.prepare('DELETE FROM bridge_map WHERE created_at + COALESCE(ttl, 86400000) < ?').run(Date.now());
    if (info.changes > 0) {
        winston.debug(`[database] purged ${info.changes} expired bridge_map entries`);
    }
};

/* ---------------- uploads ---------------- */

const recordUpload = (objectKey, url, size, expiryAt) => {
    db.prepare(`
        INSERT OR REPLACE INTO uploads (object_key, url, size, created_at, expiry_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(objectKey, url, size || 0, Date.now(), expiryAt);
};

/**
 * 刪除已過期的對象存儲文件（S3 兼容 API）並清理數據庫記錄
 */
const cleanupExpiredUploads = async () => {
    if (!s3Config) return;

    const expired = db.prepare(`
        SELECT object_key FROM uploads WHERE expiry_at <= ?
    `).all(Date.now());

    if (expired.length === 0) return;

    const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = new S3Client({
        endpoint: s3Config.endpoint,
        region: s3Config.region || 'auto',
        credentials: {
            accessKeyId: s3Config.accessKeyId,
            secretAccessKey: s3Config.secretAccessKey,
        },
    });

    let deleted = 0;
    for (const row of expired) {
        try {
            await s3.send(new DeleteObjectCommand({ Bucket: s3Config.bucket, Key: row.object_key }));
            deleted++;
        } catch (e) {
            winston.warn(`[database] failed to delete ${row.object_key}: ${e.message}`);
        }
    }
    db.prepare('DELETE FROM uploads WHERE expiry_at <= ?').run(Date.now());
    if (deleted > 0) {
        winston.info(`[database] cleaned up ${deleted}/${expired.length} expired uploads`);
    }
};

const dumpAll = () => db.prepare('SELECT * FROM bridge_map').all();

/* ---------------- message_log（互联群組消息記錄） ---------------- */

const MESSAGE_LOG_TTL = 14 * 24 * 3600 * 1000;   // 保留 14 天（AI 上下文恢復只需最近幾十條）

let stmtLogMessage = null;

/**
 * 記錄一條互联群組消息。source 標識來源：
 * 'user'=群友發言 / 'notice'=系統通知 / 其他=發送插件名（如 'aichat'）
 */
const logMessage = ({ toUid, fromUid, nick, text, source, client }) => {
    if (!stmtLogMessage) {
        stmtLogMessage = db.prepare(`
            INSERT INTO message_log (created_at, to_uid, from_uid, nick, text, source, client)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
    }
    stmtLogMessage.run(
        Date.now(),
        String(toUid),
        fromUid !== undefined && fromUid !== null ? String(fromUid) : null,
        nick !== undefined && nick !== null ? String(nick) : null,
        text !== undefined && text !== null ? String(text) : '',
        source || 'user',
        client !== undefined && client !== null ? String(client) : null,
    );
};

/** 取某群組最近 limit 條記錄（時間升序） */
const getRecentMessages = (toUid, limit = 20) => {
    return db.prepare(`
        SELECT * FROM (
            SELECT * FROM message_log WHERE to_uid = ? ORDER BY id DESC LIMIT ?
        ) ORDER BY id ASC
    `).all(String(toUid), limit);
};

const purgeOldMessages = () => {
    const info = db.prepare('DELETE FROM message_log WHERE created_at < ?').run(Date.now() - MESSAGE_LOG_TTL);
    if (info.changes > 0) {
        winston.debug(`[database] purged ${info.changes} old message_log rows`);
    }
};

module.exports = {
    dumpAll,
    init,
    rememberSent,
    lookupForward,
    lookupByForwardId,
    cleanupBridgeMap,
    recordUpload,
    cleanupExpiredUploads,
    logMessage,
    getRecentMessages,
    purgeOldMessages,
};
