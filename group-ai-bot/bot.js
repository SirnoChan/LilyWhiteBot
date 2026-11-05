/*
 * group-ai-bot —— 独立群聊 AI 机器人（Gemini 后端）
 *
 * 与 LilyWhiteBot 完全分开：独立进程/目录/日志，共用同一个 QQ 号（NapCat）。
 * NapCat 需配置第二个 HTTP 上报地址指向本进程（config.json 的 listen 端口）。
 *
 * 行为：
 * - 只在「已启用」的群里发言；群主/管理员（config.adminQQ）在群里发
 *   「AI开启 / AI关闭 / AI重置」即可增删群与清空上下文（持久化到 state.json）
 * - 触发：@机器人 或 回复机器人的消息；其余群消息仅作为上下文记录
 * - 上下文：每群保留最近 maxHistory 条，重启即失
 * - 限额：每群 cooldownSec 秒冷却 + 全局 dailyLimit 次/天，防免费额度被打爆
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const STATE_FILE = path.join(__dirname, 'state.json');

let enabledGroups = new Set();
try {
    enabledGroups = new Set(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).groups || []);
} catch (e) { /* 首次运行无 state 文件 */
}
const saveState = () => {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({ groups: [...enabledGroups] }, null, 1));
    } catch (e) {
        console.error('[group-ai] saveState failed:', e.message);
    }
};

const history = new Map();        // groupId -> [{ role: 'user'|'assistant', name?, text }]
const recentBotMsgs = new Map();  // bot 消息 id -> 时间戳（用于识别「回复机器人」触发）
const lastReplyAt = new Map();    // groupId -> ts（冷却）
const lastMsgText = new Map();    // groupId -> 上一条消息文本（重复刷屏去重）
const daily = { date: '', n: 0 };

const SELF = String(CFG.selfId);
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);

const textOf = (msg) => (Array.isArray(msg.message) ? msg.message : [])
    .filter((s) => s && s.type === 'text')
    .map((s) => s.data && s.data.text)
    .join('')
    .trim();

const hasAtSelf = (msg) => (Array.isArray(msg.message) ? msg.message : [])
    .some((s) => s && s.type === 'at' && String(s.data && s.data.qq) === SELF);

const repliesToBot = (msg) => (Array.isArray(msg.message) ? msg.message : [])
    .some((s) => s && s.type === 'reply' && recentBotMsgs.has(String(s.data && s.data.id)));

const reply = async (gid, text) => {
    const body = await napcatApi('/send_group_msg', {
        group_id: Number(gid),
        message: [{ type: 'text', data: { text: String(text).slice(0, CFG.maxReplyChars || 2000) } }],
    });
    if (body && body.data && body.data.message_id) {
        recentBotMsgs.set(String(body.data.message_id), Date.now());
        // 清理 1 小时前的记录
        for (const [k, t] of recentBotMsgs) {
            if (Date.now() - t > 3600 * 1000) recentBotMsgs.delete(k);
        }
    }
    return body;
};

const napcatApi = async (endpoint, payload) => {
    const res = await fetch(CFG.napcatApi.replace(/\/+$/u, '') + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(25000),
    });
    return res.json();
};

// 把 AI 的回答以標準 OneBot 事件形式投遞給 LWBot 的事件入口，
// 由 LWBot 橋接到其他平台（NapCat 的 WS/HTTP 服務端不上報自我消息，只能自己送）
const forwardToLwbot = async (gid, text) => {
    if (!CFG.lwbotPostUrl) return;
    try {
        await fetch(CFG.lwbotPostUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                post_type: 'message',
                message_type: 'group',
                group_id: Number(gid),
                user_id: Number(SELF),
                self_id: Number(SELF),
                time: Math.floor(Date.now() / 1000),
                message_id: Date.now(),
                sender: { nickname: 'Lily White', card: 'Lily' },
                message: [{ type: 'text', data: { text: String(text) } }],
            }),
            signal: AbortSignal.timeout(10000),
        });
    } catch (e) {
        log(`lwbot forward failed: ${e.message}`);
    }
};

// 下載圖片並轉成 Gemini inline_data（>4MB 或抓取失敗則跳過）
const fetchImagePart = async (url) => {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length || buf.length > 4 * 1024 * 1024) return null;
        const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
        return { inline_data: { mime_type: mime, data: buf.toString('base64') } };
    } catch (e) {
        return null;
    }
};

// msgs: [{ role: 'user'|'assistant'|'system', content, images? }]（OpenAI 風格）
// 一律走 Gemini 原生端點：支持 google_search 聯網 + inline_data 圖片識別
const geminiChat = async (msgs, images = []) => {
    const sys = msgs.find((m) => m.role === 'system');
    const contents = [];
    for (const m of msgs) {
        if (m.role === 'system') continue;
        contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
    }
    if (images.length && contents.length) {
        const last = contents[contents.length - 1];
        let n = 0;
        for (const url of images) {
            if (n >= (CFG.maxImages || 3)) break;
            const part = await fetchImagePart(url);
            if (part) {
                last.parts.push(part);
                n++;
            }
        }
    }
    const body = {
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 800 },
    };
    if (sys) body.systemInstruction = { parts: [{ text: sys.content }] };
    if (CFG.gemini.search) body.tools = [{ google_search: {} }];
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${CFG.gemini.model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': CFG.gemini.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
        const t = await res.text();
        throw new Error(`Gemini HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    const cand = data.candidates && data.candidates[0];
    const out = cand && cand.content && cand.content.parts
        ? cand.content.parts.map((p) => p.text || '').join('').trim()
        : '';
    if (!out) throw new Error('Gemini 返回空');
    return out;
};

const pendingTimers = new Map();  // groupId -> 防抖定时器（合并连续消息）

// 回應：讀取群歷史（含防抖窗口內合併的多條消息與圖片），生成一條回答
const respondNow = async (gid, explicit) => {
    const h = history.get(gid) || [];
    if (!h.length) return;

    if (!CFG.gemini.apiKey) {
        return void (explicit ? reply(gid, '（AI 未配置 Gemini key，请联系管理员）') : undefined);
    }

    // 限额与冷却
    const today = new Date().toISOString().slice(0, 10);
    if (daily.date !== today) {
        daily.date = today;
        daily.n = 0;
    }
    if (daily.n >= (CFG.dailyLimit || 200)) {
        return void (explicit ? reply(gid, '（今天的额度用完了，明天再来吧）') : undefined);
    }
    const now = Date.now();
    if (now - (lastReplyAt.get(gid) || 0) < (CFG.cooldownSec || 3) * 1000) return;
    lastReplyAt.set(gid, now);
    daily.n++;

    // 组装上下文：最近 maxHistory 条，标注说话人
    const msgs = [{ role: 'system', content: CFG.systemPrompt || '你是群聊里的 AI 助手。用简体中文回答，简洁自然，通常不超过 200 字。不确定的信息不要编造。' }];
    for (const m of h.slice(-(CFG.maxHistory || 20))) {
        const prefix = m.role === 'assistant' ? '' : `${m.name}：`;
        msgs.push({ role: m.role, content: prefix + (m.text || '') });
    }

    // 图片：取「上一条 AI 回复之后」的所有图片（合计最多 maxImages 张）
    let images = [];
    for (let i = h.length - 1; i >= 0; i--) {
        if (h[i].role === 'assistant') break;
        if (Array.isArray(h[i].images)) images.push(...h[i].images);
    }
    images = images.slice(-(CFG.maxImages || 3));

    try {
        const answer = await geminiChat(msgs, images);
        h.push({ role: 'assistant', text: answer.slice(0, 300) });
        while (h.length > (CFG.maxHistory || 20)) h.shift();
        // 已識別的圖片從歷史中移除，避免下次重複送模型
        for (const m of h) m.images = undefined;
        await reply(gid, answer);
        await forwardToLwbot(gid, answer);
        log(`[${gid}] -> ${answer.slice(0, 60)}`);
    } catch (e) {
        log(`[${gid}] gemini error: ${e.message}`);
        await reply(gid, '（AI 出错了，稍后再试）').catch(() => {});
    }
};

const onGroupMessage = async (ev) => {
    const gid = String(ev.group_id);
    const uid = String(ev.user_id);
    if (uid === SELF) return;

    const sender = (ev.sender && (ev.sender.card || ev.sender.nickname)) || uid;
    const text = textOf(ev);
    const segs = Array.isArray(ev.message) ? ev.message : [];
    // 收集圖片段 URL（供 AI 識別）
    const images = segs
        .filter((sg) => sg && sg.type === 'image')
        .map((sg) => sg.data && sg.data.url)
        .filter((u) => u && /^https?:\/\//u.test(u));
    const isAdmin = (CFG.adminQQ || []).includes(uid);

    // 管理指令（任意群，无需先启用）
    if (isAdmin) {
        if (/^AI开启$/u.test(text)) {
            enabledGroups.add(gid);
            saveState();
            log(`enabled group ${gid}`);
            return void reply(gid, 'AI 已在本群启用，@我 提问即可');
        }
        if (/^AI关闭$/u.test(text)) {
            enabledGroups.delete(gid);
            history.delete(gid);
            saveState();
            log(`disabled group ${gid}`);
            return void reply(gid, 'AI 已在本群停用');
        }
        if (/^AI重置$/u.test(text) && enabledGroups.has(gid)) {
            history.delete(gid);
            return void reply(gid, '对话上下文已重置');
        }
    }

    if (!enabledGroups.has(gid)) return;   // 核心约束：只在指定群发言

    // 群历史记录（文本 + 图片 URL，作为触发时的上下文）
    const h = history.get(gid) || [];
    if (text || images.length) {
        h.push({ role: 'user', name: sender, text: (text || '[图片]').slice(0, 300), images: images.length ? images : undefined });
    }
    while (h.length > (CFG.maxHistory || 20)) h.shift();
    history.set(gid, h);

    const explicit = hasAtSelf(ev) || repliesToBot(ev);
    // 免触发模式下去重：与上一条消息完全相同的文本（重复刷屏/双发）不重复回应
    if (!explicit && CFG.triggerAll && text && text === (lastMsgText.get(gid) || '')) {
        return;
    }
    lastMsgText.set(gid, text || '');

    // @/回复：立即取消未决的防抖并马上回答
    if (explicit) {
        if (pendingTimers.has(gid)) {
            clearTimeout(pendingTimers.get(gid));
            pendingTimers.delete(gid);
        }
        return void respondNow(gid, true).catch((e) => log(`respond error: ${e.message}`));
    }

    // 免触发模式：防抖合并——等一小段把连续多条消息凑齐后一次回应
    if (CFG.triggerAll && (text || images.length)) {
        if (pendingTimers.has(gid)) clearTimeout(pendingTimers.get(gid));
        pendingTimers.set(gid, setTimeout(() => {
            pendingTimers.delete(gid);
            respondNow(gid, false).catch((e) => log(`respond error: ${e.message}`));
        }, CFG.debounceMs || 6000));
    }
};

const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
    }
    let body = '';
    req.on('data', (c) => {
        body += c;
        if (body.length > 2 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        let ev;
        try {
            ev = JSON.parse(body);
        } catch (e) {
            return;
        }
        if (!ev || ev.post_type !== 'message' || ev.message_type !== 'group') return;
        onGroupMessage(ev).catch((e) => console.error('[group-ai] event error:', e.message));
    });
});

server.listen(CFG.listenPort || 11235, '127.0.0.1', () => {
    log(`group-ai-bot listening on 127.0.0.1:${CFG.listenPort || 11235}; enabled groups: ${enabledGroups.size}; gemini key: ${CFG.gemini.apiKey ? 'set' : 'NOT SET'}`);
});
