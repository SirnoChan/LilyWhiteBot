/*
 * aichat —— LWBot 原生 AI 聊天（Lily White 人设，与 ai 摘要互相独立）
 *
 * 能力（跨所有互联平台）：
 * - 三档回复预设（config.yml aichat.replyMode 手动切换）：
 *     auto    = 默认。被@/回复必须回应（禁止 [SKIP] 沉默）；其余消息先由便宜评审模型判断
 *               是否值得回应（输出 SKIP / REPLY / REPLY n，n=按语义回溯的上下文条数，
 *               主模型按 n 取历史；通过才调主模型生成；带图片消息跳过评审），评审的决定即最终决策
 *     all     = 群里每条消息都回应（排队逐条发送，间隔 replyAllIntervalSec，默认 30 秒）
 *     mention = 只回应被@/被回复的消息，其余保持沉默（历史照常记录作上下文）
 * - 上下文持久化：互联群组消息记录在 SQLite message_log（含插件来源列），重启后自动恢复群聊上下文
 * - 跨平台上下文：互联群共享同一段对话历史（桥接副本并入目标群上下文与数据库镜像行），
 *   任一平台的 AI 都能看到其他平台群友的发言；回应判定仍只在消息源平台，避免双回复
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
 *   apiBase / apiKey / model / search / imageModel / safetyOff / fallback{...} / judge{...}
 *   triggerAll: true
 *   replyMode: auto                    # auto（默认）/ all / mention 三档预设
 *   replyAllIntervalSec: 30            # all 模式逐条回应的间隔（秒）
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
    // 回应评审模型（auto 模式先用便宜模型判断消息是否值得回应，通过才调主模型生成）。
    // 默认复用 fallback 配置（z.ai glm-4.5-flash 免费）；无 fallback key 时退回主模型自判。
    const judgeOpt = options.judge || {};
    const judgeCfg = {
        apiBase: (judgeOpt.apiBase || fallback.apiBase || 'https://api.z.ai/api/paas/v4').replace(/\/+$/u, ''),
        apiKey: judgeOpt.apiKey || fallback.apiKey || '',
        model: judgeOpt.model || fallback.model || 'glm-4.5-flash',
    };
    const triggerAll = options.triggerAll !== false;
    // 三档回复预设：auto（被@/回复必答，其余是否回应由 AI 判断）/ all（逐条必答，间隔发送）/ mention（只答被@/回复）
    // 未显式配置时兼容旧 triggerAll：false → mention，true（默认）→ auto
    const replyMode = ['all', 'auto', 'mention'].includes(options.replyMode)
        ? options.replyMode
        : (options.triggerAll === false ? 'mention' : 'auto');
    const replyAllIntervalMs = (options.replyAllIntervalSec || 30) * 1000;
    const replyAllQueueMax = options.replyAllQueueMax || 10;
    const debounceMs = options.debounceMs || 6000;
    const cooldownMs = (options.cooldownSec || 30) * 1000;   // 仅 !ai 快捷命令使用；群聊回应不再有冷却门槛
    // 话题密度动态防抖：群越吵，防抖合并窗口越长
    const debounceMinMs = options.debounceMinMs || 4000;
    const debounceMaxMs = options.debounceMaxMs || 15000;
    const msgTimes = new Map();   // chatKey -> 最近消息时间戳（算话题密度用）
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
    const daily = { date: '', n: 0 };

    // 话题密度（0-1）：按最近 60 秒内的消息条数归一（25 条/分钟封顶）
    const densityOf = (chatKey) => {
        const times = msgTimes.get(chatKey) || [];
        const now = Date.now();
        const recent = times.filter((t) => now - t < 60 * 1000).length;
        return Math.min(1, recent / 25);
    };
    const lerp = (a, b, t) => Math.round(a + (b - a) * t);

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

    // 强制回应场景（被@/回复点名 / all 模式 / 评审通过）附加到 system prompt 的硬性要求
    const forceSuffix = (explicit, judgeApproved) => explicit
        ? '\n\n【硬性要求】用户刚刚@了你或回复了你的消息，这是点名，必须针对其内容给出实质回应；禁止输出 [SKIP]，禁止保持沉默。'
        : (judgeApproved
            ? '\n\n【硬性要求】评审已判定这条消息值得回应，请给出简短自然的回应；禁止输出 [SKIP]，禁止保持沉默。'
            : '\n\n【硬性要求】本群当前为逐条回应模式，每一条消息都必须得到你的回应；禁止输出 [SKIP]，禁止保持沉默。');
    // 重试后模型仍坚持沉默时的保底回应
    const forcedFallbackText = '（在的在的……不过这条我真不知道说什么好，能再说具体一点吗）';

    // 重启后从 SQLite message_log 恢复群聊上下文（bridge 只记录互联群组）：
    // source='user' → 群友发言（user 角色），source='aichat' → Lily 自己的回复（assistant 角色）
    const rebuildHistoryFromDb = () => {
        let database;
        try {
            database = require('../lib/database.js');   // transport 插件已先完成 init（config 插件顺序）
        } catch (e) {
            return;
        }
        for (const chatKey of enabledChat) {
            try {
                const rows = database.getRecentMessages(chatKey, maxHistory);
                if (!rows || !rows.length) continue;
                const h = [];
                for (const r of rows) {
                    if (r.source === 'user') {
                        h.push({ role: 'user', name: r.nick || r.from_uid || '?', text: String(r.text || '').slice(0, 300) || '[图片]' });
                    } else if (r.source === 'aichat') {
                        const t = String(r.text || '').replace(/^🤖 ?/u, '').slice(0, 300);
                        if (t) h.push({ role: 'assistant', text: t });
                    }
                }
                if (h.length) {
                    history.set(chatKey, h);
                    log(`[${chatKey}] 从数据库恢复 ${h.length} 条上下文`);
                }
            } catch (e) { /* 单群恢复失败不影响其他群 */ }
        }
    };
    rebuildHistoryFromDb();

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
            const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
            if (!res.ok) return null;
            let buf = Buffer.from(await res.arrayBuffer());
            if (!buf.length) return null;
            let mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
            // 超过 3.5MB（群友长截图常见）→ sharp 缩到 1600px JPEG，保证能送进 Gemini
            if (buf.length > 3.5 * 1024 * 1024) {
                try {
                    buf = await require('sharp')(buf).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
                    mime = 'image/jpeg';
                } catch (e) { /* 缩图失败继续尝试原图 */ }
            }
            if (buf.length > 6 * 1024 * 1024) return null;
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

    // ---------------- 回应评审（auto 模式，便宜模型先判断是否值得回应） ----------------
    // 评审窗口比主模型默认上下文更大，以便按语义回溯需要多少条历史（REPLY 数字）
    const judgeHistory = options.judgeHistory || 40;
    const JUDGE_PROMPT = '你是群聊 AI「Lily」的回应评审。根据最近群聊记录（可能包含跨平台互联群友的发言），判断 Lily 是否应该回应最新一条消息。\n' +
        '值得回应（REPLY）：有具体内容可聊、有人提问或求助、有人提到或问候 Lily、能接上的趣事。\n' +
        '不值得回应（SKIP）：纯表情或灌水、无信息量的单字、明显不是说给 Lily 听、没有可回应的内容。\n' +
        '特别注意：消息中出现 ＠Lily、@Lily White、莉莉、@Lily_White_bot 等提及 Lily 的内容，或是在回复 Lily 说的话，一律视为点名，必须 REPLY。\n' +
        '平时宁可不说话，不确定时倾向 SKIP。\n' +
        '输出格式（三选一）：\n' +
        'SKIP\n' +
        'REPLY\n' +
        'REPLY 数字 —— 该消息需要回溯更早的对话才能回应时，数字 = 相关上下文需要的最近消息条数（如 REPLY 35）\n' +
        '不要输出其他内容。\n\n最近群聊记录：\n';
    const judgeChat = async (chatKey) => {
        if (!judgeCfg.apiKey) return { verdict: 'REPLY', context: 0 };   // 未配置评审模型 → 退回主模型自判
        const h = (history.get(chatKey) || []).slice(-judgeHistory);
        const lines = h.map((m) => `${m.role === 'assistant' ? 'Lily' : (m.name || '?')}：${m.text || '[图片]'}`);
        const body = {
            model: judgeCfg.model,
            messages: [{ role: 'user', content: JUDGE_PROMPT + lines.join('\n') + '\n\n判断最后一条消息，按上述格式输出：' }],
            temperature: 0.2,
            max_tokens: 1000,
        };
        // GLM 系列关闭思考模式（否则评审延迟 6s+ 且易超时；实测关闭后 ~0.6s）
        if (/z\.ai|bigmodel\.cn/u.test(judgeCfg.apiBase)) body.thinking = { type: 'disabled' };
        const res = await fetch(`${judgeCfg.apiBase}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${judgeCfg.apiKey}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) throw new Error(`judge HTTP ${res.status}`);
        const data = await res.json();
        const out = String(data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim().toUpperCase();
        if (/SKIP/.test(out)) return { verdict: 'SKIP', context: 0 };
        const m = out.match(/REPLY\s*(\d{1,3})?/u);
        if (m) {
            const n = m[1] ? Math.min(Math.max(parseInt(m[1], 10), 4), 80) : 0;
            return { verdict: 'REPLY', context: n };
        }
        throw new Error(`judge 输出无法解析: ${out.slice(0, 40)}`);
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

    // ---------------- TTS 语音（Gemini 原生 TTS，语音请求关键词或 [VOICE] 标记触发） ----------------
    const ttsOpt = options.tts || {};
    const ttsEnabled = ttsOpt.enabled !== false;   // 默认开启；仅语音请求关键词/[VOICE] 触发，成本可控
    const ttsModel = ttsOpt.model || 'gemini-3.8-flash-tts';
    const ttsVoice = ttsOpt.voice || 'Leda';          // 女声；可用 Kore/Puck/Aoede 等
    const ttsMaxChars = ttsOpt.maxChars || 600;
    const TTS_STYLE = '用轻快俏皮、元气满满的少女语气说：';

    // PCM(16bit 单相) 包上 WAV 头，各平台语音接口都能吃
    const pcmToWav = (pcm, rate) => {
        const hdr = Buffer.alloc(44);
        hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVE', 8);
        hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
        hdr.writeUInt32LE(rate, 24); hdr.writeUInt32LE(rate * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
        hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
        return Buffer.concat([hdr, pcm]);
    };

    // 文本转语音，返回临时 wav 文件路径；文本先去 Markdown 符号（否则会被念出来）
    const geminiSpeak = async (rawText) => {
        const text = TTS_STYLE + String(rawText)
            .replace(/\[DRAW:[^\]]*\]/gu, '')
            .replace(/[*`#>]+/gu, '')
            .replace(/https?:\/\/\S+/gu, '')
            .trim()
            .slice(0, ttsMaxChars);
        if (!text.replace(TTS_STYLE, '').trim()) throw new Error('TTS 文本为空');
        const body = {
            contents: [{ role: 'user', parts: [{ text }] }],
            generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: ttsVoice } } },
            },
        };
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${ttsModel}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120000),
        });
        if (!res.ok) {
            const t = await res.text();
            throw new Error(`TTS HTTP ${res.status}: ${t.slice(0, 120)}`);
        }
        const data = await res.json();
        const part = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts
            ? data.candidates[0].content.parts.find((p) => p.inlineData && p.inlineData.data)
            : null;
        if (!part) throw new Error('TTS 未返回音频');
        const mime = String(part.inlineData.mimeType || 'audio/L16;rate=24000');
        const rate = parseInt((mime.match(/rate=(\d+)/) || [0, '24000'])[1], 10) || 24000;
        const wav = pcmToWav(Buffer.from(part.inlineData.data, 'base64'), rate);
        const wavPath = path.join(tmpDir, 'aichat-tts-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.wav');
        fs.writeFileSync(wavPath, wav);
        return wavPath;
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
        await client.send(new PutObjectCommand({ Bucket: s3.bucket, Key: key, Body: buf, ContentType: ext === '.png' ? 'image/png' : (ext === '.wav' ? 'audio/wav' : 'image/jpeg') }));
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
                const bm = new bridge.BridgeMsg(msg, {
                    nick: 'Lily',
                    text: (text ? '🖼 ' : '') + urls.join(' '),
                    extra: { files },
                });
                bm._pluginSource = 'aichat';   // 插件来源标记：消息记录归属 + intake 跳过自己的广播回流
                bridge.send(bm);
                for (const im of tmpImages) fs.unlink(im.path, () => {});
            } catch (e) {
                winston.warn(`[aichat] image bridge failed: ${e.message}`);
            }
        }
    };

    // ---------------- 回應核心 ----------------
    // explicit：被@/回复点名（有额度提示等用户可见反馈）；force：强制回应（绕过冷却、禁止 [SKIP]）。explicit 蕴含 force
    const respondNow = async (msg, explicit, force = explicit) => {
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
        // 是否回应不做冷却门槛——auto 模式由 AI 判断（[SKIP] 沉默协议），被@/回复与 all 模式必答；
        // 仅记录节奏供 !ai 快捷命令共享
        lastReplyAt.set(chatKey, Date.now());

        // 图片：取「上一条 AI 回复之后」的图片 URL
        let images = [];
        for (let i = h.length - 1; i >= 0; i--) {
            if (h[i].role === 'assistant') break;
            if (Array.isArray(h[i].images)) images.push(...h[i].images);
        }
        images = images.slice(-maxImages);

        try {
            let answer;
            let judgeApproved = false;
            let judgeContext = 0;   // 评审按语义判定的上下文容量（条数），0 = 用默认 maxHistory
            // auto 模式非强制回应：评审模型先判断是否值得回应（免费/便宜档），通过才调主模型生成。
            // 带图片的消息跳过评审（评审模型看不了图，交由主模型带视觉自判）。
            if (!force && !images.length && judgeCfg.apiKey) {
                try {
                    const jc = await judgeChat(chatKey);
                    if (jc.verdict === 'SKIP') {
                        log(`[${chatKey}] -> [SKIP]（评审模型 ${judgeCfg.model} 判定沉默）`);
                        return;
                    }
                    judgeApproved = true;   // 评审通过：主模型禁止再 [SKIP]，其决定即为最终回应决策
                    judgeContext = jc.context;
                    log(`[${chatKey}] 评审通过${judgeContext ? `（上下文 ${judgeContext} 条）` : ''}，主模型生成回应`);
                } catch (e) {
                    log(`judge failed (${e.message})，退回主模型自判`);
                }
            }
            // 主模型上下文：评审给出了容量按其取，否则默认 maxHistory
            const msgs = [{ role: 'system', content: systemPrompt + '\n群友要求语音、朗读或唱歌时，正常给出回应内容，并在回复最末尾单独一行输出 [VOICE]，系统会据此把回应转成语音发送；未被要求语音时不要输出 [VOICE]。' }];
            for (const m of h.slice(-(judgeContext || maxHistory))) {
                const prefix = m.role === 'assistant' ? '' : `${m.name}：`;
                msgs.push({ role: m.role, content: prefix + (m.text || '') });
            }
            try {
                answer = await geminiChat(msgs, images);
            } catch (e) {
                log(`gemini failed (${e.message}), using GLM fallback`);
                answer = await fallbackChat(msgs);
            }
            // 沉默協議：模型判斷不值得回應時只輸出 [SKIP]，保持安靜（强制回应/评审通过场景除外）
            if (/^\[SKIP\]\s*$/u.test(answer.trim())) {
                if (!force && !judgeApproved) {
                    log(`[${chatKey}] -> [SKIP]（AI 决定保持沉默）`);
                    return;
                }
                // 被点名/逐条/评审通过禁止沉默：附加硬性要求重试一次（Gemini → GLM 兜底），仍沉默则给保底回应
                log(`[${chatKey}] -> [SKIP] 但本次必须回应，重试`);
                const msgs2 = msgs.slice();
                msgs2[0] = { role: 'system', content: msgs[0].content + forceSuffix(explicit, judgeApproved) };
                try {
                    answer = await geminiChat(msgs2, images);
                } catch (e2) {
                    try {
                        answer = await fallbackChat(msgs2);
                    } catch (e3) {
                        answer = '';
                    }
                }
                if (!answer || /^\[SKIP\]\s*$/u.test(answer.trim())) answer = forcedFallbackText;
            }
            daily.n++;   // 每日额度只计实际回复——auto 模式下 [SKIP] 沉默决策不消耗额度
            // 语音请求：用户消息含语音关键词，或模型主动输出 [VOICE] 标记（剥掉标记再发文本）
            const voiceAsked = /语音|读出来|读一下|说出来|念出来|念一?念|唱/u.test(String(msg.text || ''));
            const voiceMarked = /\[VOICE\]/u.test(answer);
            const wantsVoice = (voiceAsked || voiceMarked) && !/^\[SKIP\]/u.test(answer);
            answer = answer.replace(/\s*\[VOICE\]\s*/gu, ' ').trim();

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
                const bm = new bridge.BridgeMsg(msg, { text: '🤖 ' + answer.slice(0, maxReplyChars), nick: 'Lily' });
                bm._pluginSource = 'aichat';   // 插件来源标记：消息记录归属 + intake 跳过自己的广播回流
                bridge.send(bm);
            } catch (e) { /* 橋接失敗忽略 */ }
            log(`[${chatKey}] -> (${answer.length}字) ${answer.slice(0, 160)}`);

            // 语音投递：文本已先发出，语音随后生成发送（TTS 失败不影响文字回复）
            if (ttsEnabled && wantsVoice && answer.trim()) {
                try {
                    const wavPath = await geminiSpeak(answer.slice(0, maxReplyChars));
                    const voiceUrl = await s3Upload(fs.readFileSync(wavPath), '.wav');
                    // 源平台：直接走该平台 processor 的 receive，语音以原生形式发进源群（QQ=CQ:record / TG=sendAudio / Discord=附件）
                    try {
                        const processor = bridge.processors.get(msg.handler.type);
                        if (processor && voiceUrl) {
                            const vm = new bridge.BridgeMsg(msg, { nick: 'Lily', text: '', extra: { uploads: [{ url: voiceUrl, type: 'audio' }] } });
                            vm._pluginSource = 'aichat';
                            await processor.receive(vm);
                        }
                    } catch (e2) {
                        log(`source voice send failed: ${e2.message}`);
                    }
                    // 其他平台：语音文件走桥接（file.js 上传后按 audio 发送）
                    try {
                        const bm = new bridge.BridgeMsg(msg, { nick: 'Lily', text: '🔊', extra: { files: [{ client: msg.handler.type, type: 'voice', path: wavPath, name: 'reply.wav' }] } });
                        bm._pluginSource = 'aichat';
                        await bridge.send(bm);
                    } catch (e3) { /* 橋接失敗忽略 */ }
                    fs.unlink(wavPath, () => {});
                    log(`[${chatKey}] -> [语音] (${ttsModel}/${ttsVoice})`);
                } catch (e2) {
                    log(`TTS failed: ${e2.message}`);
                }
            }
        } catch (e) {
            log(`respond error: ${e.message}`);
            await safeReply(msg, '（AI 出错了，稍后再试）');
        }
    };

    // ---------------- all 模式：逐条回应队列 ----------------
    // 每条消息排队回应，两次回应之间至少间隔 replyAllIntervalMs；队列超长丢弃最旧（防止热群无限堆积拖沓）
    const allQueue = new Map(); // chatKey -> { items: [], busy: false }
    const pumpAll = (chatKey) => {
        const q = allQueue.get(chatKey);
        if (!q || q.busy || !q.items.length) return;
        q.busy = true;
        const step = () => {
            const next = q.items.shift();
            if (!next) {
                q.busy = false;
                return;
            }
            respondNow(next, false, true)
                .catch((e) => log(`[${chatKey}] respond error: ${e.message}`))
                .finally(() => setTimeout(step, replyAllIntervalMs));
        };
        step();
    };
    const enqueueAll = (msg) => {
        const chatKey = msg.to_uid;
        let q = allQueue.get(chatKey);
        if (!q) {
            q = { items: [], busy: false };
            allQueue.set(chatKey, q);
        }
        if (q.items.length >= replyAllQueueMax) {
            q.items.shift();
            log(`[${chatKey}] 逐条回应队列已满（${replyAllQueueMax}），丢弃最旧一条`);
        }
        q.items.push(msg);
        pumpAll(chatKey);
    };

    // ---------------- intake（bridge.send 钩子，每条源消息进一次） ----------------
    const intake = (msg) => {
        try {
            // 自己广播的回流：跳过（回应已作为 assistant 记入历史，避免自循环与重复记录）
            if (msg._pluginSource === 'aichat') return Promise.resolve();
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

            // 话题密度采样
            if (!msgTimes.has(chatKey)) msgTimes.set(chatKey, []);
            const times = msgTimes.get(chatKey);
            times.push(Date.now());
            while (times.length > 60) times.shift();

            // 群历史（QQ 的 at 可读化：机器人自己的 @QQ号/＠qqQQ号 → ＠Lily，避免 LLM 看到裸号码）
            const selfQq = msg.handler && msg.handler._qq;
            const displayText = selfQq ? text.replace(new RegExp(`[@＠]qq?${selfQq}(?!\\d)`, 'gu'), '＠Lily') : text;
            const h = history.get(chatKey) || [];
            if (text || images.length) {
                h.push({ role: 'user', name: msg.nick || msg.from_uid, text: (displayText || '[图片]').slice(0, 300), images: images.length ? images : undefined });
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
            // QQ：消息 at 了机器人也算点名（extra.ats 含机器人 QQ 号）——群资料查询失败时
            // 文本里的 [CQ:at,qq=...] 不会被替换成昵称，纯文本匹配会漏判 @ 提问
            const atHit = (() => {
                const ats = msg.extra && msg.extra.ats;
                if (!Array.isArray(ats) || !ats.length || !selfQq) return false;
                return ats.some((a) => parseInt(a, 10) === selfQq);
            })();
            const explicit = replyToBot || nickHit || atHit;

            if (explicit) {
                // 被@/回复：任何模式都必须回应（禁止 [SKIP] 沉默）
                if (pendingTimers.has(chatKey)) {
                    clearTimeout(pendingTimers.get(chatKey));
                    pendingTimers.delete(chatKey);
                }
                respondNow(msg, true).catch((e) => log(`respond error: ${e.message}`));
                return Promise.resolve();
            }

            if (replyMode === 'mention') return Promise.resolve();   // 只回应被@/被回复，其余沉默

            const commandLike = /^[!/#]/u.test(text);

            if (replyMode === 'all') {
                // 逐条回应：每条消息都排队回应（命令除外，交回命令系统），按固定间隔发送
                if ((text || images.length) && !commandLike) enqueueAll(msg);
                return Promise.resolve();
            }

            // auto：是否回应交给 AI 判断（[SKIP] 沉默协议），不做冷却/长度/重复预过滤；
            // 仅跳过命令消息（归命令系统），防抖合并连续发言
            if (triggerAll && (text || images.length) && !commandLike) {
                if (pendingTimers.has(chatKey)) clearTimeout(pendingTimers.get(chatKey));
                const density = densityOf(chatKey);
                const effDebounce = lerp(debounceMinMs, debounceMaxMs, density);
                pendingTimers.set(chatKey, setTimeout(() => {
                    pendingTimers.delete(chatKey);
                    respondNow(msg, false).catch((e) => log(`respond error: ${e.message}`));
                }, effDebounce));
            }
        } catch (e) {
            winston.warn(`[aichat] intake error: ${e.message}`);
        }
        return Promise.resolve();
    };

    bridge.addHook('bridge.send', intake);

    // ---------------- 跨平台上下文合并 ----------------
    // 桥接副本（源消息转发到其他互联群）写入目标群历史：互联群共享同一段对话上下文，
    // QQ 侧 AI 也能看到 TG/Discord 等平台的发言（反之亦然）。
    // 只合并历史，不触发回应评估——是否回应的判定仍发生在消息源平台，避免多平台双回复。
    const intakeBridgeCopy = (msg2) => {
        try {
            const chatKey = msg2.to_uid;
            if (!chatKey) return;
            if (!(alwaysGroups.has(chatKey) || enabledChat.has(chatKey))) return;   // 仅维护启用群
            if (msg2.isNotice) return;
            const h = history.get(chatKey) || [];
            if (msg2._pluginSource === 'aichat') {
                // Lily 自己的回复桥接过来：记为 assistant 角色（剥 🤖 前缀），与其他群上下文对齐
                const t = String(msg2.text || '').replace(/^🤖 ?/u, '').slice(0, 300);
                if (t) h.push({ role: 'assistant', text: t });
            } else {
                const text = String(msg2.text || '').trim();
                h.push({ role: 'user', name: msg2.nick || '?', text: (text || '[图片]').slice(0, 300) });
            }
            while (h.length > maxHistory) h.shift();
            history.set(chatKey, h);
        } catch (e) { /* 忽略 */ }
    };
    bridge.addHook('bridge.receive', intakeBridgeCopy);

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
                const bm = new bridge.BridgeMsg(context, { text: '🤖 ' + text });
                bm._pluginSource = 'aichat';
                bridge.send(bm);
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

    winston.info(`[aichat] ready (model: ${model}, judge: ${judgeCfg.apiKey ? judgeCfg.model : 'off'}, search: ${searchEnabled}, image: ${imageModel || 'off'}, replyMode: ${replyMode}, triggerAll: ${triggerAll}, alwaysGroups: ${alwaysGroups.size})`);
};
