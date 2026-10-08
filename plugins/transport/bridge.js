'use strict';

const winston = require('winston');
const { LRUCache } = require('lru-cache');
const Context = require('../../lib/handlers/Context.js');
const BridgeMsg = require('./BridgeMsg.js');

let processors = new Map();
let hooks = {};
let hooks2 = new WeakMap();
let map = {};
let aliases = {};

// 跨平台回復/撤回的基礎：源訊息（平台|原生ID）-> 各平台轉發訊息 ID 的映射
// sent: Map<clientType, Array<{ chat/channel/room, id }>>
let msgIndex = new LRUCache({ max: 2000, ttl: 24 * 3600 * 1000 });
const msgKey = (clientType, nativeId) => `${clientType}|${nativeId}`;

// 反向索引：平台|bot 轉發訊息 ID -> 源訊息鍵（回復場景：用戶回覆的是 bot 的轉發訊息）
let sentIndex = new LRUCache({ max: 4000, ttl: 24 * 3600 * 1000 });

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

                promises.push(bridge.emitHook('bridge.receive', msg2).then(_ => {
                    let processor = processors.get(client);
                    if (processor) {
                        winston.debug(`[bridge.js] <BotTransport> #${currMsgId} ---> ${new_uid.uid}`);
                        return Promise.resolve(processor.receive(msg2)).then((sentIds) => {
                            // 記錄各平台轉發訊息的 ID，供跨平台回復/撤回使用
                            if (Array.isArray(sentIds) && sentIds.length && msg.handler && msg._nativeId !== undefined) {
                                bridge.rememberSent(msg.handler.type, msg._nativeId, client, sentIds);
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
     * 記錄「源訊息在某平台轉發後的訊息 ID」
     */
    rememberSent(fromClientType, fromNativeId, targetClientType, sentIds) {
        if (fromNativeId === undefined || fromNativeId === null || !Array.isArray(sentIds) || sentIds.length === 0) {
            return;
        }

        let key = msgKey(fromClientType, fromNativeId);
        let entry = msgIndex.get(key);
        if (!entry) {
            entry = {
                source: { client: fromClientType, id: fromNativeId },
                sent: new Map(),
            };
            msgIndex.set(key, entry);
        }

        let arr = entry.sent.get(targetClientType) || [];
        for (let s of sentIds) {
            if (s && s.id !== undefined) {
                arr.push(s);
                sentIndex.set(`${targetClientType}|${s.id}`, key);
            }
        }
        entry.sent.set(targetClientType, arr);
    },

    /**
     * 查詢某條源訊息在各平台轉發後的訊息 ID
     */
    lookupSent(fromClientType, fromNativeId) {
        if (fromNativeId === undefined || fromNativeId === null) {
            return null;
        }
        return msgIndex.get(msgKey(fromClientType, fromNativeId)) || null;
    },

    /**
     * 由「bot 在某平台轉發出的訊息 ID」反查源訊息記錄（跨平台回復用）
     */
    lookupByForwardId(clientType, botMsgId) {
        if (botMsgId === undefined || botMsgId === null) {
            return null;
        }
        let key = sentIndex.get(`${clientType}|${botMsgId}`);
        return key ? (msgIndex.get(key) || null) : null;
    },

    /**
     * 跨平台回復時，目標平台上應被引用的訊息 ID。
     * 被回覆的訊息既可能是源平台用戶的原生訊息（正查），也可能是 bot 的轉發訊息（反查）；
     * 目標平台即源平台時引用用戶的原生訊息，否則引用 bot 的轉發訊息。
     * 查不到時返回 undefined（退回文字樣式）。
     */
    replyRef(fromClientType, replyId, targetClientType) {
        if (replyId === undefined || replyId === null) {
            return undefined;
        }
        let entry = bridge.lookupSent(fromClientType, replyId) || bridge.lookupByForwardId(fromClientType, replyId);
        if (!entry || !entry.source) {
            return undefined;
        }
        if (entry.source.client === targetClientType) {
            return entry.source.id;
        }
        let ids = entry.sent.get(targetClientType);
        return (ids && ids.length) ? ids[0].id : undefined;
    },

    /**
     * 跨平台撤回：源訊息被撤回時，刪除各平台對應的轉發訊息。
     * 返回是否找到了對應記錄。
     */
    recall(fromClientType, fromNativeId) {
        let entry = bridge.lookupSent(fromClientType, fromNativeId);
        if (!entry) {
            winston.debug(`[bridge.js] <Recall> no record for ${msgKey(fromClientType, fromNativeId)}`);
            return Promise.resolve(false);
        }

        winston.info(`[bridge.js] <Recall> recalling message ${msgKey(fromClientType, fromNativeId)}`);
        let promises = [];

        for (let [clientType, sentIds] of entry.sent) {
            let handler = bridge.handlers && bridge.handlers.get(clientType);
            if (handler && typeof handler.deleteMessage === 'function') {
                for (let s of sentIds) {
                    promises.push(
                        Promise.resolve(handler.deleteMessage(s))
                            .catch(e => winston.warn(`[bridge.js] <Recall> failed on ${clientType}: ${e.message}`))
                    );
                }
            }
        }

        return Promise.all(promises).then(() => true);
    },
};

module.exports = bridge;
