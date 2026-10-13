'use strict';

const winston = require('winston');
const Context = require('../../lib/handlers/Context.js');
const BridgeMsg = require('./BridgeMsg.js');
const database = require('../../lib/database.js');

let processors = new Map();
let hooks = {};
let hooks2 = new WeakMap();
let map = {};
let aliases = {};

// TODO 独立的命令处理
// let commands = {};

const getBridgeMsg = (msg) => {
    if (msg instanceof BridgeMsg) {
        return msg;
    } else {
        return new BridgeMsg(msg);
    }
};

const prepareMsg = (msg) => {
    // 檢查是否有傳送目標
    let alltargets = map[msg.to_uid];
    let targets = [];
    for (let t in alltargets) {
        if (!alltargets[t].disabled) {
            targets.push(t);
        }
    }

    // 向 msg 中加入附加訊息
    msg.extra.clients = targets.length + 1;
    msg.extra.mapto = targets;
    if (aliases[msg.to_uid]) {
        msg.extra.clientName = aliases[msg.to_uid];
    } else {
        msg.extra.clientName = {
            shortname: msg.handler.id,
            fullname: msg.handler.type,
        };
    }

    return bridge.emitHook('bridge.send', msg);
};

const bridge = {
    get map() { return map; },
    set map(obj) { map = obj; },
    get aliases() { return aliases; },
    set aliases(obj) { aliases = obj; },
    get processors() { return processors; },
    addProcessor(type, processor) { processors.set(type, processor); },
    deleteProcessor(type) { processors.delete(type); },
    addHook(event, func, priority = 100) {
        // Event:
        // bridge.send：剛發出，尚未準備傳話
        // bridge.receive：已確認目標
        if (!hooks[event]) {
            hooks[event] = new Map();
        }
        let m = hooks[event];
        if (m && typeof func === 'function') {
            let p = priority;
            while (m.has(p)) {
                p++;
            }
            m.set(p, func);
            hooks2.set(func, { event: event, priority: p });
        }
    },
    deleteHook(func) {
        if (hooks2.has(func)) {
            let h = hooks2.get(func);
            hooks[h.event].delete(h.priority);
            hooks2.delete(func);
        }
    },
    emitHook(event, msg) {
        let r = Promise.resolve();
        if (hooks[event]) {
            for (let [priority, hook] of hooks[event]) {
                r = r.then(_ => hook(msg));
            }
        }
        return r;
    },

    send(m) {
        let msg = getBridgeMsg(m);

        let currMsgId = msg.msgId;
        winston.debug(`[bridge.js] <UserSend> #${currMsgId} ${msg.from_uid} ---> ${msg.to_uid}: ${msg.text}`);
        let extraJson = JSON.stringify(msg.extra);
        if (extraJson !== 'null' && extraJson !== '{}') {
            winston.debug(`[bridge.js] <UserSend> #${currMsgId} extra: ${extraJson}`);
        }

        return prepareMsg(msg).then(() => {
            // 全部訊息已傳送 resolve(true)，部分訊息已傳送 resolve(false)；
            // 所有訊息被拒絕傳送 reject()
            // Hook 需自行處理異常

            // 向對應目標的 handler 觸發 exchange
            let promises = [];
            let allresolved = true;

            for (let t of msg.extra.mapto) {
                let msg2 = new BridgeMsg(msg, {
                    to_uid: t
                });
                let new_uid = BridgeMsg.parseUID(t);
                let client = new_uid.client;

                msg2._sourceChat = msg.to;   // 源訊息所在的聊天（to 被改寫為目標前保存）
                console.error('DBG loop: t=' + t + ' msg.to=' + msg.to + ' msg2._sourceChat=' + msg2._sourceChat);
                promises.push(bridge.emitHook('bridge.receive', msg2).then(_ => {
                    let processor = processors.get(client);
                    if (processor) {
                        winston.debug(`[bridge.js] <BotTransport> #${currMsgId} ---> ${new_uid.uid}`);
                        return Promise.resolve(processor.receive(msg2)).then((sentIds) => {
                            // 記錄各平台轉發訊息的 ID，供跨平台回復/撤回使用
                            if (Array.isArray(sentIds) && sentIds.length && msg.handler && msg._nativeId !== undefined) {
                bridge.rememberSent(msg.handler.type, msg._nativeId, msg.to, client, sentIds);
                            }
                        });
                    } else {
                        winston.debug(`[bridge.js] <BotTransport> #${currMsgId} -X-> ${new_uid.uid}: No processor`);
                    }
                }));
            }

            return Promise.all(promises)
                .catch((e) => {
                    allresolved = false;
                    winston.error(`[bridge.js] <BotSend> Rejected: ${e && e.message ? e.message : e}\n${e && e.stack ? e.stack : ''}`);
                }).then(() => {
                    bridge.emitHook('bridge.sent', msg);
                    if (promises.length > 0) {
                        winston.debug(`[bridge.js] <BotSend> #${currMsgId} done.`);
                    } else {
                        winston.debug(`[bridge.js] <BotSend> #${currMsgId} has no targets. Ignored.`);
                    }
                    return Promise.resolve(allresolved);
                });
        });
    },

    /**
     * 記錄「源訊息在某平台轉發後的訊息 ID」（SQLite）
     */
    rememberSent(fromClientType, fromNativeId, fromChat, targetClientType, sentIds) {
        if (fromNativeId === undefined || fromNativeId === null || !Array.isArray(sentIds) || sentIds.length === 0) {
            return;
        }
        try {
            database.rememberSent(fromClientType, fromNativeId, fromChat, targetClientType, sentIds);
        } catch (e) {
            winston.warn(`[bridge.js] rememberSent failed: ${e.message}`);
        }
    },

    /**
     * 查詢某條源訊息在各平台轉發後的訊息 ID（兼容接口，返回 { sent: Map } 形狀）
     */
    lookupSent(fromClientType, fromNativeId) {
        const rows = database.lookupForward(fromClientType, fromNativeId);
        if (!rows) return null;
        const sent = new Map();
        for (const r of rows) {
            sent.set(r.target_client, [{ chat: r.target_chat, id: r.target_id }]);
        }
        return { sent };
    },

    /**
     * 由「bot 在某平台轉發出的訊息 ID」反查源訊息（兼容接口，返回 { source } 形狀）
     */
    lookupByForwardId(clientType, botMsgId) {
        const rows = database.lookupByForwardId(clientType, botMsgId);
        if (!rows) return null;
        return { source: { client: rows[0].source_client, id: rows[0].source_id } };
    },

    /**
     * 跨平台回復時，目標平台上應被引用的訊息 ID。
     * 被回覆的訊息既可能是源平台用戶的原生訊息（正查），也可能是 bot 的轉發訊息（反查）；
     * 目標平台即源平台時引用用戶的原生訊息，否則引用 bot 的轉發訊息。
     * 查不到時返回 undefined（退回文字樣式）。
     */
    replyRef(fromClientType, replyId, chat, targetClientType) {
        if (replyId === undefined || replyId === null) {
            return undefined;
        }

        try {
            // chat = 回復發生的聊天（互聯群組）。反查與正查都限定在該聊天內：
            // 反查：回復的是 bot 的轉發訊息；正查：回復的是源平台用戶的原生訊息
            const srcRows = database.lookupByForwardId(fromClientType, replyId, chat);
            if (srcRows && srcRows.length) {
                const source = srcRows[0];
                if (source.source_client === targetClientType) {
                    return source.source_id;
                }
                const fwd = database.lookupForward(source.source_client, source.source_id, source.source_chat) || [];
                const hit = fwd.find(r => r.target_client === targetClientType);
                return hit ? hit.target_id : undefined;
            }

            const fwdRows = database.lookupForward(fromClientType, replyId, chat);
            if (fwdRows && fwdRows.length) {
                const hit = fwdRows.find(r => r.target_client === targetClientType);
                return hit ? hit.target_id : undefined;
            }
        } catch (e) {
            winston.warn(`[bridge.js] replyRef query failed: ${e.message}`);
        }

        winston.debug(`[bridge.js] <ReplyRef> no map entry for ${fromClientType}|${replyId} (target ${targetClientType}) - falling back to text style`);
        return undefined;
    },

    /**
     * 跨平台撤回：源訊息被撤回時，刪除各平台對應的轉發訊息。
     * 返回是否找到了對應記錄。
     */
    recall(fromClientType, fromNativeId) {
        const rows = database.lookupForward(fromClientType, fromNativeId);
        if (!rows || !rows.length) {
            winston.debug(`[bridge.js] <Recall> no record for ${fromClientType}|${fromNativeId}`);
            return Promise.resolve(false);
        }

        winston.info(`[bridge.js] <Recall> recalling message ${fromClientType}|${fromNativeId}`);
        let promises = [];

        for (let row of rows) {
            let handler = bridge.handlers && bridge.handlers.get(row.target_client);
            if (handler && typeof handler.deleteMessage === 'function') {
                const chat = row.target_chat !== undefined && row.target_chat !== null ? row.target_chat : row.target_id;
                promises.push(
                    Promise.resolve(handler.deleteMessage({ id: row.target_id, chat, channel: chat, room: chat }))
                        .catch(e => winston.warn(`[bridge.js] <Recall> failed on ${row.target_client}: ${e.message}`))
                );
            }
        }

        return Promise.all(promises).then(() => true);
    },
};

module.exports = bridge;
