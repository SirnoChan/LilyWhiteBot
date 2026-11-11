/*
 * aichat —— LWBot 原生 AI 聊天（Lily White 人设，与 ai 摘要互相独立）
 *
 * 能力（跨所有互联平台）：
 * - 免触发模式：启用群里任意消息都可能引出回答（冷却 + 每日限额 + 防抖合并连续消息）
 * - @/回复触发：@机器人昵称、回复机器人桥接消息 → 立即回答
 * - 看图：消息里的图片以 inline_data 送 Gemini 视觉
 * - 画图：文字模型输出 [DRAW:提示词] → Nano Banana 生成（支持图生图：参考图一并送入），
 *   Gemini 失败退 Pollinations 兜底；文字模型言语拒绝画图意图时直接走兜底渠道
 * - 联网搜索：google_search grounding
 * - GLM 免费兜底：Gemini 限流/超上限时自动切换（失去搜索/看图，聊天不中断）
 * - 管理：AI开启 / AI关闭 / AI重置（仅 adminIds）
 * - 快捷命令：!ai / /ai 单轮问答
 *
 * config.yml：
 *
 * aichat:
 *   systemPrompt: "..."
 *   apiBase / apiKey / model / search / imageModel / safetyOff / fallback{...}
 *   triggerAll: true
 *   alwaysGroups: ["qq/942574893"]     # 永久启用群（uid 格式）
 *   adminIds: ["qq/1832396853"]
 *   botNickTriggers: ["莉莉", "@Lily"] # 文本命中即触发
 *   debounceMs / cooldownSec / dailyLimit / maxHistory / maxReplyChars
 *   maxImages: 3 / maxDrawImages: 4 / maxTokens: 8192
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const winston = require('winston');

module.exports = (pluginManager, options) => {
    const bridge = pluginManager.plugins.transport;
    if (!bridge) {
        winston.error('[aichat] Transport plugin not loaded, aichat disabled.');
        return;
    }

    const apiBase = (options.apiBase || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/+$/u, '');
    const apiKey = options.apiKey || '';
    const model = options.model || 'gemini-3.8-flash';
    const imageModel = options.imageModel || '';
    const searchEnabled = options.search !== false;
    const safetyOff = options.safetyOff !== false;
    const systemPrompt = options.systemPrompt || '你是群聊 AI 助手。用简体中文回答，简洁自然。';
    const fallback = options.fallback || {};
    const triggerAll = options.triggerAll !== false;
    const debounceMs = options.debounceMs || 6000;
    const cooldownMs = (options.cooldownSec || 30) * 1000;
    const dailyLimit = options.dailyLimit || 200;
    const maxHistory = options.maxHistory || 20;
    const maxReplyChars = options.maxReplyChars || 2000;
    const maxChars = options.maxChars || 2000;
    const maxImages = options.maxImages || 3;
    const maxDrawImages = options.maxDrawImages || 4;
    const maxTokens = options.maxTokens || 8192;
    const alwaysGroups = new Set(options.alwaysGroups || []);
    const adminIds = new Set(options.adminIds || []);
    const botNickTriggers = options.botNickTriggers || [];
    const tmpDir = options.tmpDir || '/tmp';

    if (!apiKey) {
        winston.error('[aichat] apiKey not configured, aichat disabled.');
        return;
    }

    const GEMINI_SAFETY_OFF = [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
        { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' },
    ];

    // ---------------- 状态 ----------------
    const history = new Map();       // chatKey -> [{ role, name, text, images? }]
    const pendingTimers = new Map(); // chatKey -> 防抖 timer
    const lastReplyAt = new Map();
    const lastMsgText = new Map();
    const daily = { date: '', n: 0 };

    const enabledFile = path.join(tmpDir, 'aichat-enabled.json');
    const enabledChat = new Set();
    try {
        const st = JSON.parse(fs.readFileSync(enabledFile, 'utf8'));
        for (const g of st.groups || []) enabledChat.add(g);
    } catch (e) { /* 首次运行 */ }
    for (const g of alwaysGroups) enabledChat.add(g);
    const saveEnabled = () => {
        try {
            for (const g of alwaysGroups) enabledChat.add(g);
            fs.writeFileSync(enabledFile, JSON.stringify({ groups: [...enabledChat] }, null, 1));
        } catch (e) { /* 忽略 */ }
    };
    saveEnabled();

    const log = (...a) => winston.info(`[aichat] ${a.join(' ')}`);

// BridgeMsg 没有 reply 方法；统一经 handler.reply 路由（返回 Promise 或 void）
const safeReply = (msg, text) => {
    try {
        return Promise.resolve(msg.handler.reply(msg, String(text), { noPrefix: true })).catch((e) => winston.warn(`[aichat] reply failed: ${e.message}`));
    } catch (e) {
        winston.warn(`[aichat] reply threw: ${e.message}`);
        return Promise.resolve();
    }
};

    // ---------------- Gemini 调用 ----------------
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

    // msgs: [{ role: 'system'|'user'|'assistant', content }]（OpenAI 风格）
    const geminiChat = async (msgs, extraImages = []) => {
        const sys = msgs.find((m) => m.role === 'system');
        const contents = [];
        for (const m of msgs) {
            if (m.role === 'system') continue;
            contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
        }
        if (extraImages.length && contents.length) {
            const last = contents[contents.length - 1];
            let n = 0;
            for (const url of extraImages) {
                if (n >= maxImages) break;
                const part = await fetchImagePart(url);
                if (part) {
                    last.parts.push(part);
                    n++;
                }
            }
        }
        const body = {
            contents,
            generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } },
        };
        if (sys) body.systemInstruction = { parts: [{ text: sys.content }] };
        if (searchEnabled) body.tools = [{ google_search: {} }];
        if (safetyOff) body.safetySettings = GEMINI_SAFETY_OFF;
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(90000),
        });
        if (!res.ok) {
            const t = await res.text();
            throw new Error(`Gemini HTTP ${res.status}: ${t.slice(0, 150)}`);
        }
        const data = await res.json();
        const cand = data.candidates && data.candidates[0];
        const out = cand && cand.content && cand.content.parts
            ? cand.content.parts.map((p) => p.text || '').join('').trim()
            : '';
        if (!out) throw new Error('Gemini 返回空');
        return out;
    };

    const fallbackChat = async (msgs) => {
        if (!fallback.apiKey) throw new Error('无可用兜底模型');
        const call = async () => {
            const res = await fetch(`${(fallback.apiBase || 'https://api.z.ai/api/paas/v4').replace(/\/+$/u, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${fallback.apiKey}` },
                body: JSON.stringify({
                    model: fallback.model || 'glm-4.5-flash',
                    messages: msgs.map((m) => ({ role: m.role, content: m.content })),
                    temperature: 0.7,
                    max_tokens: 4000,
                }),
                signal: AbortSignal.timeout(90000),
            });
            if (!res.ok) throw new Error(`fallback HTTP ${res.status}`);
            const data = await res.json();
            const out = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
            if (!out) throw new Error('fallback 返回空');
            return String(out).trim();
        };
        try {
            return await call();
        } catch (e) {
            await new Promise((r) => setTimeout(r, 3000));
            return await call();
        }
    };

    // ---------------- 画图 ----------------
    const drawImage = async (prompt, refUrls = []) => {
        const parts = [];
        for (const u of refUrls.slice(0, 3)) {
            const part = await fetchImagePart(u);
            if (part) parts.push(part);
        }
        parts.push({ text: prompt });
        const body = {
            contents: [{ role: 'user', parts }],
            generationConfig: { temperature: 0.9, maxOutputTokens: maxTokens, responseModalities: ['TEXT', 'IMAGE'], thinkingConfig: { thinkingBudget: 0 } },
        };
        if (safetyOff) body.safetySettings = GEMINI_SAFETY_OFF;
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${imageModel}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120000),
        });
        if (!res.ok) {
            const t = await res.text();
            throw new Error(`image model HTTP ${res.status}: ${t.slice(0, 150)}`);
        }
        const data = await res.json();
        const outParts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts || [];
        let caption = '';
        let file = null;
        for (const p of outParts) {
            if (p.text) caption += p.text;
            const img = p.inlineData || p.inline_data;
            if (img && img.data) file = 'base64://' + img.data;
        }
        if (!file) throw new Error('image model 未返回图片');
        return { caption: caption.trim(), file };
    };

    const drawImageFallback = async (prompt) => {
        const res = await fetch(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&model=flux`, {
            signal: AbortSignal.timeout(180000),
        });
        if (!res.ok) throw new Error(`pollinations HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) throw new Error('pollinations 返回空');
        return { caption: '', file: 'base64://' + buf.toString('base64') };
    };

    const drawImageAny = async (prompt, refUrls = []) => {
        try {
            return await drawImage(prompt, refUrls);
        } catch (e) {
            log(`gemini image failed (${e.message}), falling back to pollinations`);
            return await drawImageFallback(prompt);
        }
    };

    // ---------------- 发送 ----------------
    const s3Upload = async (buf, ext) => {
        const s3 = pluginManager.global.servemediaS3;
        if (!s3 || !s3.bucket || !s3.publicBase) return null;
        const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
        const client = new S3Client({
            endpoint: s3.endpoint,
            region: s3.region || 'auto',
            credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
        });
        const key = (s3.keyPrefix || 'lwb/') + crypto.createHash('md5').update(buf).digest('hex') + ext;
        await client.send(new PutObjectCommand({ Bucket: s3.bucket, Key: key, Body: buf, ContentType: ext === '.png' ? 'image/png' : 'image/jpeg' }));
        return s3.publicBase.replace(/\/+$/u, '') + '/' + key;
    };

    const saveBase64Tmp = (b64, ext) => {
        const f = path.join(tmpDir, 'aichat-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + ext);
        fs.writeFileSync(f, Buffer.from(b64, 'base64'));
        return f;
    };

    // 回答發送到源平台（文字+圖片直鏈），圖片同時經 file.js 橋接為其餘平台的真圖片
    const sendChatReply = async (msg, text, tmpImages) => {
        await safeReply(msg, text);
        if (tmpImages && tmpImages.length) {
            try {
                const files = [];
                const urls = [];
                for (const im of tmpImages) {
                    try {
                        const url = await s3Upload(fs.readFileSync(im.path), path.extname(im.path) || '.png');
                        if (url) urls.push(url);
                    } catch (e) { /* 上傳失敗仍走 files 橋接 */ }
                    files.push({ client: msg.handler ? msg.handler.type : 'QQ', type: 'image', path: im.path, name: path.basename(im.path) });
                }
                bridge.send(new bridge.BridgeMsg(msg, {
                    nick: 'Lily',
                    text: (text ? '🖼 ' : '') + urls.join(' '),
                    extra: { files },
                }));
                for (const im of tmpImages) fs.unlink(im.path, () => {});
            } catch (e) {
                winston.warn(`[aichat] image bridge failed: ${e.message}`);
            }
        }
    };

    // ---------------- 回應核心 ----------------
    const respondNow = async (msg, explicit) => {
        const chatKey = msg.to_uid;
        const h = history.get(chatKey) || [];
        if (!h.length) return;

        if (!apiKey) {
            return void (explicit ? safeReply(msg, '（AI 未配置 key，请联系管理员）') : undefined);
        }

        const today = new Date().toISOString().slice(0, 10);
        if (daily.date !== today) {
            daily.date = today;
            daily.n = 0;
        }
        if (daily.n >= dailyLimit) {
            return void (explicit ? safeReply(msg, '（今天的额度用完了，明天再来吧）') : undefined);
        }
        const now = Date.now();
        if (now - (lastReplyAt.get(chatKey) || 0) < cooldownMs) return;
        lastReplyAt.set(chatKey, now);
        daily.n++;

        const msgs = [{ role: 'system', content: systemPrompt }];
        for (const m of h.slice(-maxHistory)) {
            const prefix = m.role === 'assistant' ? '' : `${m.name}：`;
            msgs.push({ role: m.role, content: prefix + (m.text || '') });
        }

        // 图片：取「上一条 AI 回复之后」的图片 URL
        let images = [];
        for (let i = h.length - 1; i >= 0; i--) {
            if (h[i].role === 'assistant') break;
            if (Array.isArray(h[i].images)) images.push(...h[i].images);
        }
        images = images.slice(-maxImages);

        try {
            let answer;
            try {
                answer = await geminiChat(msgs, images);
            } catch (e) {
                log(`gemini failed (${e.message}), using GLM fallback`);
                answer = await fallbackChat(msgs);
            }

            // 画图：解析 [DRAW: ...] 标记（支持多张）
            const drawMatches = [...answer.matchAll(/\[DRAW:\s*([^\]]{5,600})\]/gu)];
            if (imageModel && drawMatches.length) {
                const chatText = answer.slice(0, drawMatches[0].index).trim();
                const outTextParts = [chatText].filter(Boolean);
                const tmpImages = [];
                let drawn = 0;
                for (const dm of drawMatches) {
                    if (drawn >= maxDrawImages) break;
                    try {
                        const { file } = await drawImageAny(dm[1].trim(), images);
                        const ext = '.png';
                        tmpImages.push({ path: saveBase64Tmp(file.replace('base64://', ''), ext) });
                        drawn++;
                    } catch (e2) {
                        log(`draw #${drawn + 1} failed: ${e2.message}`);
                    }
                }
                if (drawn) {
                    const outText = outTextParts.join('\n').trim() || `[图片x${drawn}]`;
                    await sendChatReply(msg, outText, tmpImages);
                    h.push({ role: 'assistant', text: (chatText || `[图片x${drawn}]`).slice(0, 300) });
                    while (h.length > maxHistory) h.shift();
                    for (const m of h) m.images = undefined;
                    log(`[${chatKey}] -> [AI画图x${drawn}]`);
                    return;
                }
                // 全部失败：剥掉标记继续走文字回答
                answer = (chatText || '（画图失败了，稍后再试）');
            }

            h.push({ role: 'assistant', text: answer.slice(0, 300) });
            while (h.length > maxHistory) h.shift();
            for (const m of h) m.images = undefined;
            await safeReply(msg, answer.slice(0, maxReplyChars));
            try {
                bridge.send(new bridge.BridgeMsg(msg, { text: '🤖 ' + answer.slice(0, maxReplyChars), nick: 'Lily' }));
            } catch (e) { /* 橋接失敗忽略 */ }
            log(`[${chatKey}] -> (${answer.length}字) ${answer.slice(0, 160)}`);
        } catch (e) {
            log(`respond error: ${e.message}`);
            await safeReply(msg, '（AI 出错了，稍后再试）');
        }
    };

    // ---------------- intake（bridge.send 钩子，每条源消息进一次） ----------------
    const intake = (msg) => {
        try {
            const chatKey = msg.to_uid;
            if (!chatKey) return Promise.resolve();

            const enabled = alwaysGroups.has(chatKey) || enabledChat.has(chatKey);
            const text = String(msg.text || '').trim();
            const isAdmin = adminIds.has(msg.from_uid);

            // 管理指令（跨平台）
            if (isAdmin) {
                if (/^AI开启$/u.test(text)) {
                    enabledChat.add(chatKey);
                    saveEnabled();
                    safeReply(msg, 'AI 已在本群启用，@我 或直接说话即可');
                    log(`enabled ${chatKey}`);
                    return Promise.resolve();
                }
                if (/^AI关闭$/u.test(text)) {
                    enabledChat.delete(chatKey);
                    history.delete(chatKey);
                    saveEnabled();
                    safeReply(msg, 'AI 已在本群停用');
                    log(`disabled ${chatKey}`);
                    return Promise.resolve();
                }
                if (/^AI重置$/u.test(text)) {
                    history.delete(chatKey);
                    safeReply(msg, '对话上下文已重置');
                    return Promise.resolve();
                }
            }

            if (!enabled) return Promise.resolve();

            // 收集图片 URL（各平台处理器已把图片放入 extra.files 并带 url）
            const images = (msg.extra.files || [])
                .map((f) => f.url)
                .filter((u) => u && /^https?:\/\//u.test(u));

            // 群历史
            const h = history.get(chatKey) || [];
            if (text || images.length) {
                h.push({ role: 'user', name: msg.nick || msg.from_uid, text: (text || '[图片]').slice(0, 300), images: images.length ? images : undefined });
            }
            while (h.length > maxHistory) h.shift();
            history.set(chatKey, h);

            const replyToBot = (() => {
                const r = msg.extra.reply;
                if (!r) return false;
                if (r._isBot) return true;                                    // QQ 標記
                if (r._id !== undefined && msg.handler) {
                    return !!bridge.lookupByForwardId(msg.handler.type, r._id, msg.to);   // 回復的是橋接消息（bot 的話）
                }
                return false;
            })();
            const nickHit = botNickTriggers.some((n) => text.includes(n));
            const explicit = replyToBot || nickHit;

            // 免触模式下去重
            if (!explicit && triggerAll && text && text === (lastMsgText.get(chatKey) || '')) {
                return Promise.resolve();
            }
            lastMsgText.set(chatKey, text || '');

            if (explicit) {
                if (pendingTimers.has(chatKey)) {
                    clearTimeout(pendingTimers.get(chatKey));
                    pendingTimers.delete(chatKey);
                }
                respondNow(msg, true).catch((e) => log(`respond error: ${e.message}`));
                return Promise.resolve();
            }

            if (triggerAll && (text || images.length)) {
                if (pendingTimers.has(chatKey)) clearTimeout(pendingTimers.get(chatKey));
                pendingTimers.set(chatKey, setTimeout(() => {
                    pendingTimers.delete(chatKey);
                    respondNow(msg, false).catch((e) => log(`respond error: ${e.message}`));
                }, debounceMs));
            }
        } catch (e) {
            winston.warn(`[aichat] intake error: ${e.message}`);
        }
        return Promise.resolve();
    };

    bridge.addHook('bridge.send', intake);

    // ---------------- !ai 快捷单轮命令 ----------------
    const quickAsk = (context, cmd, param) => {
        const q = String(param || '').trim();
        if (!q) {
            context.reply('用法：!ai 问题');
            return;
        }
        const now = Date.now();
        if (now - (lastReplyAt.get(context.to_uid) || 0) < cooldownMs) return;
        lastReplyAt.set(context.to_uid, now);
        const msgs = [{ role: 'system', content: systemPrompt }, { role: 'user', content: q.slice(0, 2000) }];
        geminiChat(msgs).catch(() => fallbackChat(msgs)).then((answer) => {
            const text = String(answer).slice(0, maxChars);
            context.reply(text).catch(() => {});
            try {
                bridge.send(new bridge.BridgeMsg(context, { text: '🤖 ' + text }));
            } catch (e) { /* 忽略 */ }
        }).catch((e) => {
            winston.warn(`[aichat] quick ask failed: ${e.message}`);
            context.reply('（AI 出错了，稍后再试）').catch(() => {});
        });
    };

    for (let [type, handler] of pluginManager.handlers) {
        handler.addCommand('!ai', quickAsk);
        handler.addCommand('/ai', quickAsk);
    }

    winston.info(`[aichat] ready (model: ${model}, search: ${searchEnabled}, image: ${imageModel || 'off'}, triggerAll: ${triggerAll}, alwaysGroups: ${alwaysGroups.size})`);
};
