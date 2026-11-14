'use strict';

const BridgeMsg = require('../BridgeMsg.js');
const LRU = require('lru-cache');
const format = require('string-format');
const winston = require('winston');

const pkg = require('../../../package.json');
const USERAGENT = `LilyWhiteBot/${pkg.version} (${pkg.repository})`;

const truncate = (str, maxLen = 10) => {
    str = str.replace(/\n/gu, '');
    if (str.length > maxLen) {
        str = str.substring(0, maxLen - 3) + '...';
    }
    return str;
};

let bannedMessage = new LRU.LRUCache({
    max: 500,
    ttl: 300000,
});
let groupInfo = new LRU.LRUCache({
    max: 5000,   // 成员列表预热会整群写入（一条约百字节），5000 条 ≈ 数个大群
    ttl: 3600000,
});
// 群成员昵称缓存预热：at 替换不依赖消息时刻的 API 状态（凌晨 NapCat 抖动时用白天的缓存）
const warmGroups = new Set();
setInterval(() => {
    for (const g of warmGroups) {
        qqHandler.groupMemberList(g).then((list) => {
            if (Array.isArray(list)) {
                for (const m of list) {
                    const info = { qq: m.user_id !== undefined ? m.user_id : m.qq, name: m.nickname, groupCard: m.card };
                    if (info.qq !== undefined && info.qq !== null) {
                        groupInfo.set(`${info.qq}@${g}`, info);
                    }
                }
            }
        }).catch(() => { /* 下轮再试 */ });
    }
}, 20 * 60 * 1000).unref();

let bridge = null;
let pluginManager = null;
let config = null;
let qqHandler = null;
let forwardBots = [];

let options = {};


const parseForwardBot = (text, options) => {
    let tester = {};
    for (let style in options) {
      tester[style] = {};
      for (let template in options[style]) {
          tester[style][template] = new RegExp("^" + options[style][template].replace(/\[/g, "\\[").replace(/\]/g, "\\]").replace(/\*/g, "\\*")
            .replace("{text}", "(?<text>[^]*)").replace("{nick}", "(?<nick>.*?)").replace(/\{[^\{\}]+\}/g, "(.*?)") + "$", "mu");
      };
    };

    let groups;
    if (tester.complex.reply.test(text)) {
        groups = text.match(tester.complex.reply).groups || {};
    } else if (tester.complex.forward.test(text)) {
        groups = text.match(tester.complex.forward).groups || {};
    } else if (tester.complex.action.test(text)) {
        groups = text.match(tester.complex.action).groups || {};
    } else if (tester.complex.message.test(text)) {
        groups = text.match(tester.complex.message).groups || {};
    } else if (tester.complex.notice.test(text)) {
        groups = text.match(tester.complex.notice).groups || {};
        groups.nick = "";
    } else if (tester.simple.reply.test(text)) {
        groups = text.match(tester.simple.reply).groups || {};
    } else if (tester.simple.forward.test(text)) {
        groups = text.match(tester.simple.forward).groups || {};
    } else if (tester.simple.action.test(text)) {
        groups = text.match(tester.simple.action).groups || {};
    } else if (tester.simple.message.test(text)) {
        groups = text.match(tester.simple.message).groups || {};
    } else if (tester.simple.notice.test(text)) {
        groups = text.match(tester.simple.notice).groups || {};
        groups.nick = "";
    } else {
      groups = {nick: undefined, text: undefined}
    }

    return { realNick: groups.nick, realText: groups.text };
};

const init = (b, h, c, pm) => {
    pluginManager = pm || pluginManager;
    bridge = b;
    config = c;
    qqHandler = h;

    options = config.options.QQ || {};
    forwardBots = options.forwardBots || [];

    // 消息样式
    let messageStyle = config.options.messageStyle;

    if (!options.notify) {
        options.notify = {};
    }

    // 訊息撤回：QQ 用戶撤回自己（已被轉發過）的訊息時，撤回各平台的轉發
    qqHandler.on('recall', (data) => {
        bridge.recall('QQ', data.nativeId);
    });

    // 群文件上傳：以通知 + 文件本體（可下載時）轉發到其他群組
    qqHandler.on('groupfile', async (data) => {
        const getFriendlySize = (n) => {
            if (n <= 1126) return `${n} B`;
            if (n <= 1153433) return `${(n / 1024).toLocaleString()} KB`;
            if (n <= 1181116006) return `${(n / 1048576).toLocaleString()} MB`;
            return `${(n / 1073741824).toLocaleString()} GB`;
        };

        let nick = `QQ:${data.user}`;
        try {
            nick = (await qqHandler.groupMemberInfo(data.group, data.user)).name || nick;
        } catch (e) { /* 拿不到群名片用默認 */ }

        // 超過 20MB 的文件不抓取本體（下載+上傳鏈路風險高），只發通知
        const MAX_TRANSFER = 20 * 1024 * 1024;
        let files;
        if (data.fileId && data.size > 0 && data.size <= MAX_TRANSFER) {
            const content = await qqHandler.getGroupFileContent(data.fileId);
            if (content) {
                files = [{
                    client: 'QQ',
                    type: 'file',
                    id: data.fileId,
                    name: data.name,
                    size: data.size,
                    url: content.url,
                    path: content.path,
                }];
            }
        }

        bridge.send(new BridgeMsg({
            from: data.user,
            to: data.group,
            nick: nick,
            text: `📁 上傳了群文件：${data.name}（${getFriendlySize(data.size)}）`,
            isNotice: !files,
            extra: { files: files },
            handler: qqHandler,
        })).catch(e => winston.error(e.stack || e.message));
    });

    /*
     * 傳話
     */
    // 將訊息加工好並發送給其他群組
    qqHandler.on('text', async (context) => {
        const send = () => bridge.send(context).catch(e => winston.error(e.stack));

        // // 「應用消息」
        // if (context.from === 1000000 && options.notify.sysmessage) {
        //     bridge.send(new BridgeMsg(context, {
        //         isNotice: true,
        //     }));
        //     return;
        // }

        let extra = context.extra;

        // 檢查是不是在回覆自己
        if (extra.reply && forwardBots.includes(`${extra.reply.qq}`)) {
            let { realNick, realText } = parseForwardBot(extra.reply.message, messageStyle);
            if (realText) {
                [extra.reply.nick, extra.reply.message] = [realNick, realText];
            }
        }

        // 合併轉發消息：自動拉取內容，生成摘要一併轉發（可用 forwardSummary: false 關閉）
        if (context.extra.forward && context.extra.forward.length && options.forwardSummary !== false) {
            try {
                let { data } = await qqHandler.getForwardMsg(context.extra.forward[0]);
                let messages = (data && data.messages) || [];
                if (messages.length) {
                    const entries = [];
                    for (let m of messages) {
                        let nick = (m.sender && (m.sender.card || m.sender.nickname)) || '';
                        let content = m.content || m.message || [];
                        let text = typeof content === 'string' ? content : (qqHandler.parseMessage(content).text || '');
                        text = String(text).replace(/\n/gu, ' ').trim();
                        // 收集圖片段，供 AI 視覺摘要識別圖片內容
                        let images = typeof content === 'string' ? [] : content
                            .filter((s) => s && s.type === 'image')
                            .map((s) => s.data && (s.data.url || s.data.file))
                            .filter((u) => u && /^https?:\/\//u.test(u));
                        if (!text && images.length) text = '[图片]';
                        if (text || images.length) entries.push({ nick, text, images });
                    }

                    let summaryBlock;
                    if (pluginManager.global.ai && pluginManager.global.ai.aiAvailable()) {
                        try {
                            const aiOut = await pluginManager.global.ai.summarizeMergedForward(entries);
                            summaryBlock = `「AI 摘要｜合并转发 ${entries.length} 条」
` + aiOut;
                        } catch (e) {
                            winston.warn(`AI summary failed, falling back to list: ${e.message}`);
                        }
                    }

                    if (!summaryBlock) {
                        let limit = options.forwardSummaryLines || 5;
                        let lines = [];
                        for (let e of entries.slice(0, limit)) {
                            let text = e.text.length > 30 ? e.text.slice(0, 30) + '…' : e.text;
                            lines.push(`> ${e.nick}: ${text}`);
                        }
                        if (entries.length > limit) {
                            lines.push(`……共 ${entries.length} 条`);
                        }
                        summaryBlock = `「合并转发 ${entries.length} 条」\n` + lines.join('\n');
                    }

                    const qmultiHint = (context.extra.forward && context.extra.forward.length)
                        ? '\n[私聊机器人使用 !qmulti ' + context.extra.forward[0] + ' 以查看转发消息]' : '';
                    context.text = summaryBlock + qmultiHint;
                }
            } catch (e) {
                winston.warn(`Failed to fetch forward msg summary: ${e.message}`);
            }
        }

        // 過濾口令紅包
        if (context.extra.isCash) {
            let key = `${context.to}: ${context.text}`;
            if (!bannedMessage.has(key)) {
                bannedMessage.set(key, true);
                bridge.send(new BridgeMsg(context, {
                    text: `已暫時屏蔽「${context.text}」`,
                    isNotice: true,
                }));
            }
            return;
        }

        if (!context.isPrivate && context.extra.ats && context.extra.ats.length > 0) {
            // 查询 QQ 的 at：缓存 → 批量成员列表（顺带预热缓存）→ 单查（重试一次）→ 兜底可读文本。
            // parser 已把 at 段转成文本「@QQ号」，这里把号码换成群昵称——否则跨平台只能看到裸号码
            // （旧实现的 [CQ:at,...] 正则从未匹配过，昵称替换一直是死代码）。
            warmGroups.add(context.to);

            const resolveAts = async () => {
                const ats = context.extra.ats.filter((a) => /^\d+$/u.test(String(a)));
                const resolved = new Map();   // at -> info | null
                const missing = [];
                for (const at of ats) {
                    const key = `${at}@${context.to}`;
                    if (groupInfo.has(key)) { resolved.set(at, groupInfo.get(key)); continue; }
                    missing.push(at);
                }
                if (missing.length) {
                    // 批量拉成员列表（含机器人自己的群名片），成功即预热全群缓存
                    let list = null;
                    try {
                        list = await qqHandler.groupMemberList(context.to);
                    } catch (e) { /* 列表失败再走单查 */ }
                    if (Array.isArray(list)) {
                        for (const m of list) {
                            const info = { qq: m.user_id !== undefined ? m.user_id : m.qq, name: m.nickname, groupCard: m.card };
                            if (info.qq !== undefined && info.qq !== null) {
                                groupInfo.set(`${info.qq}@${context.to}`, info);
                            }
                        }
                    }
                    for (const at of missing) {
                        const key = `${at}@${context.to}`;
                        if (groupInfo.has(key)) { resolved.set(at, groupInfo.get(key)); continue; }
                        let info = null;
                        try {
                            info = await qqHandler.groupMemberInfo(context.to, at);
                        } catch (e) {
                            try {
                                await new Promise((r) => setTimeout(r, 1200));   // NapCat 瞬时抖动重试一次
                                info = await qqHandler.groupMemberInfo(context.to, at);
                            } catch (e2) { /* 放弃，走兜底文本 */ }
                        }
                        if (info) {
                            groupInfo.set(`${info.qq || at}@${context.to}`, info);
                            resolved.set(at, info);
                        } else {
                            resolved.set(at, null);
                            if (list) groupInfo.set(key, null);   // 列表成功但无此人（多半已退群），缓存空标记避免反复查询
                        }
                    }
                }
                return resolved;
            };

            resolveAts().then((resolved) => {
                for (const at of resolved.keys()) {
                    const info = resolved.get(at);
                    let atText;
                    if (info) {
                        const user = {
                            sender: {
                                user_id: info.qq !== undefined ? info.qq : at,
                                nickname: info.name,
                                card: info.groupCard,
                            }
                        };
                        atText = `＠${qqHandler.escape(qqHandler.getNick(user))}`;
                    } else {
                        atText = `＠qq${at}`;   // 查不到昵称（API 全挂/已退群）：至少可读，不漏裸号码
                    }
                    // parser 产出「@QQ号」；(?!\d) 防止误匹配更长号码的前缀
                    context.text = context.text.replace(new RegExp(`@${at}(?!\\d)`, 'gu'), atText);
                }
            }).catch(e => winston.error(e.stack)).then(() => send());
        } else {
            send();
        }
    });

    /*
     * 加入與離開
     */
    qqHandler.on('join', (data) => {
        if (options.notify.join) {
            bridge.send(new BridgeMsg({
                from: data.group,
                to: data.group,
                nick: data.user_target.name,
                text: `${data.user_target.name} (${data.target}) 加入QQ群`,
                isNotice: true,
                handler: qqHandler,
                _rawdata: data,
            })).catch(e => winston.error(e.stack));
        }
    });

    qqHandler.on('leave', (data) => {
        let text;
        if (data.target === data.admin || data.admin === 0) {
            text = `${data.user_target.name} (${data.target}) 退出QQ群`;
        } else {
            text = `${data.user_target.name} (${data.target}) 被管理員 ${data.user_admin.name} (${data.admin}) 踢出QQ群`;
        }

        if (groupInfo.has(`${data.target}@${data.group}`)) {
            groupInfo.del(`${data.target}@${data.group}`);
        }

        if (options.notify.leave) {
            bridge.send(new BridgeMsg({
                from: data.group,
                to: data.group,
                nick: data.user_target.name,
                text: text,
                isNotice: true,
                handler: qqHandler,
                _rawdata: data,
            })).catch(e => winston.error(e.stack));
        }
    });

    /*
     * 管理員
     */
    qqHandler.on('admin', (data) => {
        let text;
        if (data.type === 1) {
            text = `${data.user.name} (${data.target}) 被取消管理員`;
        } else {
            text = `${data.user.name} (${data.target}) 成為管理員`;
        }

        if (options.notify.setadmin) {
            bridge.send(new BridgeMsg({
                from: data.group,
                to: data.group,
                nick: data.user.name,
                text: text,
                isNotice: true,
                handler: qqHandler,
                _rawdata: data,
            })).catch(e => winston.error(e.stack));
        }
    });

    /*
     * 禁言與解禁
     */
    qqHandler.on('ban', (data) => {
        let text = '';
        if (data.target === 0) {
            // 全體禁言
            if (data.type === 1) {
                text = "管理員開啟了全體禁言";
            } else {
                text = "管理員關閉了全體禁言";
            }
        } else {
            if (data.type === 1) {
                text = `${data.user_target.name} (${data.target}) 被禁言${data.durstr}`;
            } else {
                text = `${data.user_target.name} (${data.target}) 被解除禁言`;
            }
        }
        

        if (options.notify.ban) {
            bridge.send(new BridgeMsg({
                from: data.group,
                to: data.group,
                nick: data.user_target.name,
                text: text,
                isNotice: true,
                handler: qqHandler,
                _rawdata: data,
            })).catch(e => winston.error(e.stack));
        }
    });
};

// 收到了來自其他群組的訊息
const receive = async (msg) => {
    // 元信息，用于自定义样式
    let meta = {
        nick: msg.nick,
        from: msg.from,
        to: msg.to,
        text: msg.text,
        client_short: msg.extra.clientName.shortname,
        client_full: msg.extra.clientName.fullname,
        command: msg.command,
        param: msg.param
    };
    if (msg.extra.reply) {
        let reply = msg.extra.reply;
        meta.reply_nick = reply.nick;
        meta.reply_user = reply.username;
        if (reply.isText) {
            meta.reply_text = truncate(reply.message);
        } else {
            meta.reply_text = reply.message;
        }
    }
    if (msg.extra.forward) {
        meta.forward_nick = msg.extra.forward.nick;
        meta.forward_user = msg.extra.forward.username;
    }

    // 自定义消息样式
    let messageStyle = config.options.messageStyle;
    let styleMode = 'simple';
    if (msg.extra.clients >= 3 && (msg.extra.clientName.shortname || msg.isNotice)) {
        styleMode = 'complex';
    }

    let template;
    if (msg.isNotice) {
        template = messageStyle[styleMode].notice;
    } else if (msg.extra.isAction) {
        template = messageStyle[styleMode].action;
    } else if (msg.extra.reply) {
        template = messageStyle[styleMode].reply;
    } else if (msg.extra.forward) {
        template = messageStyle[styleMode].forward;
    } else {
        template = messageStyle[styleMode].message;
    }

    // 处理图片和音频附件
    let output = format(template, meta);
    let useragent = config.options.servemedia.userAgent || USERAGENT;
    let headers = JSON.stringify({'User-Agent': useragent});
    let mediaMessages = [];
    for (let upload of (msg.extra.uploads || [])) {
        if (upload.type === 'audio') {
            mediaMessages.push(`[CQ:record,file=${upload.url},headers=${headers}]`);
        } else if (upload.type === 'image') {
            output += '\n' + `[CQ:image,file=${upload.url},headers=${headers}]`;
        } else if (upload.type === 'video') {
            mediaMessages.push(`[CQ:video,file=${upload.url},headers=${headers}]`);
        } else {
            output += '\n' + upload.url;
        }
    }

    let sentIds = [];
    const record = (r) => {
        if (r && r.message_id !== undefined) {
            sentIds.push({ chat: msg.to, id: r.message_id });
        }
        return r;
    };

    // 原生回復：被回覆的是 bot 轉發的訊息時，以 QQ 原生回覆（CQ:reply）引用
    let replyId;
    if (msg.extra.reply && msg.extra.reply._id !== undefined) {
        let ref = bridge.replyRef(msg.handler.type, msg.extra.reply._id, msg._sourceChat, 'QQ');
        if (ref !== undefined) {
            replyId = ref;
        }
    }
    if (replyId !== undefined) {
        output = `[CQ:reply,id=${replyId}]` + output;
        for (let i = 0; i < mediaMessages.length; i++) {
            mediaMessages[i] = `[CQ:reply,id=${replyId}]` + mediaMessages[i];
        }
    }

    // 空文本消息（如 aichat 语音直发）不发送模板残片（会渲染成「[Lily]」之类的空壳行），只发媒体
    const hasText = String(msg.text || '').trim().length > 0;
    if (hasText || mediaMessages.length === 0) {
        record(await qqHandler.say(msg.to, output, {
            noEscape: true
        }));
    }

    // 影片/語音在 NT QQ 中以卡片形式渲染、同條消息中的文字不會顯示，
    // 故單獨發送（說話人資訊在上面那條文字消息中）
    for (let media of mediaMessages) {
        record(await qqHandler.say(msg.to, media, {
            noEscape: true
        }));
    }

    return sentIds;
};

module.exports = {
    init,
    receive,
};
