/*
 * database.js SQLite 持久層
 *
 * 管理兩類數據：
 * 1. bridge_map —— 跨平台回復/撤回的消息映射（24 小時 TTL）
 * 2. uploads    —— 上傳到對象存儲的文件記錄（到期自動刪除）
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
    `);

    if (s3) {
        s3Config = s3;
        // 每小時清理到期文件
        setInterval(() => {
            cleanupExpiredUploads().catch(e => winston.warn(`[database] upload cleanup failed: ${e.message}`));
        }, 3600 * 1000).unref();
    }
};

/* ---------------- bridge_map ---------------- */

const rememberSent = (sourceClient, sourceId, sourceChat, targetClient, sentIds) => {
    const now = Date.now();
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO bridge_map (map_key, source_client, source_id, source_chat, target_client, target_id, target_chat, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const s of sentIds) {
        if (s && s.id !== undefined) {
            const chat = s.chat !== undefined ? s.chat : (s.channel !== undefined ? s.channel : s.room);
            stmt.run(`${sourceClient}|${sourceId}|${targetClient}`, sourceClient, String(sourceId), sourceChat !== undefined ? String(sourceChat) : null, targetClient, String(s.id), chat !== undefined ? String(chat) : null, now);
        }
    }
    globalThis.__lwbDb = db;
};

const lookupForward = (sourceClient, sourceId, sourceChat) => {
    const rows = sourceChat !== undefined
        ? db.prepare(`
            SELECT target_client, target_id, target_chat FROM bridge_map
            WHERE source_client = ? AND source_id = ? AND source_chat = ? AND created_at > ?
        `).all(String(sourceClient), String(sourceId), String(sourceChat), Date.now() - 24 * 3600 * 1000)
        : db.prepare(`
            SELECT target_client, target_id, target_chat FROM bridge_map
            WHERE source_client = ? AND source_id = ? AND created_at > ?
        `).all(String(sourceClient), String(sourceId), Date.now() - 24 * 3600 * 1000);
    return rows.length ? rows : null;
};

const lookupByForwardId = (targetClient, botMsgId, targetChat) => {
    const rows = targetChat !== undefined
        ? db.prepare(`
            SELECT source_client, source_id, source_chat FROM bridge_map
            WHERE target_client = ? AND target_id = ? AND target_chat = ? AND created_at > ?
        `).all(String(targetClient), String(botMsgId), String(targetChat), Date.now() - 24 * 3600 * 1000)
        : db.prepare(`
            SELECT source_client, source_id, source_chat FROM bridge_map
            WHERE target_client = ? AND target_id = ? AND created_at > ?
        `).all(String(targetClient), String(botMsgId), Date.now() - 24 * 3600 * 1000);
    return rows.length ? rows : null;
};

const cleanupBridgeMap = () => {
    const info = db.prepare('DELETE FROM bridge_map WHERE created_at < ?').run(Date.now() - 24 * 3600 * 1000);
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

module.exports = {
    dumpAll,
    init,
    rememberSent,
    lookupForward,
    lookupByForwardId,
    cleanupBridgeMap,
    recordUpload,
    cleanupExpiredUploads,
};
