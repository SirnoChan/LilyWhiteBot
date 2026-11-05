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

const geminiChat = async (messages) => {
    // 聯網搜索：走 Gemini 原生端點（OpenAI 兼容層不支持 google_search 工具）
    if (CFG.gemini.search) {
        const sys = messages.find((m) => m.role === 'system');
        const contents = messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${CFG.gemini.model}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': CFG.gemini.apiKey },
            body: JSON.stringify({
                contents,
                ...(sys ? { systemInstruction: { parts: [{ text: sys.content }] } } : {}),
                tools: [{ google_search: {} }],
                generationConfig: { temperature: 0.7, maxOutputTokens: 800 },
            }),
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
    }

    const res = await fetch(CFG.gemini.apiBase.replace(/\/+$/u, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CFG.gemini.apiKey}` },
        body: JSON.stringify({
            model: CFG.gemini.model,
            messages,
            temperature: 0.7,
            max_tokens: 800,
        }),
        signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) {
        const t = await res.text();
        throw new Error(`Gemini HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    const out = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!out) throw new Error('Gemini 返回空');
    return String(out).trim();
};

const onGroupMessage = async (ev) => {
    const gid = String(ev.group_id);
    const uid = String(ev.user_id);
    if (uid === SELF) return;

    const sender = (ev.sender && (ev.sender.card || ev.sender.nickname)) || uid;
    const text = textOf(ev);
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

    // 群历史记录（所有文本消息，作为触发时的上下文）
    const h = history.get(gid) || [];
    if (text) h.push({ role: 'user', name: sender, text: text.slice(0, 300) });
    while (h.length > (CFG.maxHistory || 20)) h.shift();
    history.set(gid, h);

    const explicit = hasAtSelf(ev) || repliesToBot(ev);
    // 免触发模式下去重：与上一条消息完全相同的文本（重复刷屏/双发）不重复回应
    if (!explicit && CFG.triggerAll && text && text === (lastMsgText.get(gid) || '')) {
        return;
    }
    lastMsgText.set(gid, text || '');
    const triggered = explicit
        || (CFG.triggerAll && text);   // 免触发模式：任意文本消息都可能引出回答（仍受冷却/限额约束）
    if (!triggered) return;

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
        return void reply(gid, '（今天的额度用完了，明天再来吧）');
    }
    const now = Date.now();
    if (now - (lastReplyAt.get(gid) || 0) < (CFG.cooldownSec || 3) * 1000) return;
    lastReplyAt.set(gid, now);
    daily.n++;

    // 组装上下文：最近 maxHistory 条，标注说话人
    const msgs = [{ role: 'system', content: CFG.systemPrompt || '你是群聊里的 AI 助手。用简体中文回答，简洁自然，通常不超过 200 字。不确定的信息不要编造。' }];
    for (const m of h.slice(-(CFG.maxHistory || 20))) {
        const prefix = m.role === 'assistant' ? '' : `${m.name}：`;
        msgs.push({ role: m.role, content: prefix + m.text });
    }
    // 最后一条必须是触发者的提问（若最后一条是历史里刚记下的文本则已含）
    if (!h.length || h[h.length - 1].text !== text) {
        msgs.push({ role: 'user', content: `${sender}：${text}` });
    }

    try {
        const answer = await geminiChat(msgs);
        h.push({ role: 'assistant', text: answer.slice(0, 300) });
        await reply(gid, answer);
        await forwardToLwbot(gid, answer);
        log(`[${gid}] ${sender}: ${text.slice(0, 50)} -> ${answer.slice(0, 60)}`);
    } catch (e) {
        log(`[${gid}] gemini error: ${e.message}`);
        await reply(gid, '（AI 出错了，稍后再试）').catch(() => {});
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
