/*
 * aichat —— 跨平台 AI 问答命令（Gemini）
 *
 * 用法：!ai 问题（Telegram 用 /ai）
 * 回答先回给触发者所在平台，再经 bridge 转发到其余互联平台。
 *
 * config.yml：
 *
 * aichat:
 *   apiBase: "https://generativelanguage.googleapis.com/v1beta/openai"
 *   apiKey: ""
 *   model: "gemini-3.8-flash"
 *   systemPrompt: "..."
 *   cooldownSec: 5        # 全局冷却，防连发
 *   maxChars: 1500        # 回答截断长度
 */

'use strict';

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
    const systemPrompt = options.systemPrompt
        || '你是莉莉·怀特（Lily White），东方Project中宣告春天到来的白色百合妖精。性格天真烂漫、元气满满，最爱的口头禅是「春天到了！」。用简体中文回答问题，语气活泼俏皮、简洁明了（一般不超过 200 字）。不确定的信息不要编造；涉及时效性问题时以搜索结果为准。不要自称语言模型或程序——你就是妖精莉莉·怀特。';
    const cooldownMs = (options.cooldownSec > 0 ? options.cooldownSec : 5) * 1000;
    const maxChars = options.maxChars || 1500;

    if (!apiKey) {
        winston.error('[aichat] apiKey not configured, aichat disabled.');
        return;
    }

    let lastAt = 0;

    const ask = async (q) => {
        // 聯網搜索：走 Gemini 原生端點（OpenAI 兼容層不支持 google_search 工具）
        if (options.search) {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: q.slice(0, 2000) }] }],
                    systemInstruction: { parts: [{ text: systemPrompt }] },
                    tools: [{ google_search: {} }],
                    generationConfig: { temperature: 0.7, maxOutputTokens: 800 },
                }),
                signal: AbortSignal.timeout(60000),
            });
            if (!res.ok) {
                const t = await res.text();
                throw new Error(`HTTP ${res.status}: ${t.slice(0, 120)}`);
            }
            const d = await res.json();
            const cand = d.candidates && d.candidates[0];
            const out = cand && cand.content && cand.content.parts
                ? cand.content.parts.map((p) => p.text || '').join('').trim()
                : '';
            if (!out) throw new Error('AI 返回空');
            return out;
        }

        const res = await fetch(`${apiBase}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: q.slice(0, 2000) },
                ],
                temperature: 0.7,
                max_tokens: 800,
            }),
            signal: AbortSignal.timeout(45000),
        });
        if (!res.ok) {
            const t = await res.text();
            throw new Error(`HTTP ${res.status}: ${t.slice(0, 120)}`);
        }
        const data = await res.json();
        const out = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!out) throw new Error('AI 返回空');
        return String(out).trim();
    };

    const aiHandler = (context, cmd, param) => {
        const q = String(param || '').trim();
        if (!q) {
            context.reply('用法：!ai 问题（例如 !ai 今天适合写代码吗）');
            return;
        }

        const now = Date.now();
        if (now - lastAt < cooldownMs) {
            return;                                             // 冷却期内静默忽略
        }
        lastAt = now;

        ask(q).then((answer) => {
            const text = String(answer).slice(0, maxChars);
            context.reply(text).catch((e) => winston.warn(`[aichat] reply failed: ${e.message}`));
            // 轉發到其餘互聯平台（bridge.send 自動跳過來源平台）
            try {
                bridge.send(new bridge.BridgeMsg(context, { text: '🤖 ' + text }));
            } catch (e) {
                winston.warn(`[aichat] bridge forward failed: ${e.message}`);
            }
            winston.info(`[aichat] ${context.from_uid || context.from} asked: ${q.slice(0, 40)}`);
        }).catch(async (e) => {
            winston.warn(`[aichat] ask failed: ${e.message}`);
            // Gemini 不可用時退到 GLM 免费兜底
            const fb = options.fallback;
            if (fb && fb.apiKey) {
                try {
                    const res = await fetch(`${(fb.apiBase || 'https://api.z.ai/api/paas/v4').replace(/\/+$/u, '')}/chat/completions`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${fb.apiKey}` },
                        body: JSON.stringify({
                            model: fb.model || 'glm-4.5-flash',
                            messages: [
                                { role: 'system', content: systemPrompt },
                                { role: 'user', content: q.slice(0, 2000) },
                            ],
                            temperature: 0.7,
                            max_tokens: 800,
                        }),
                        signal: AbortSignal.timeout(60000),
                    });
                    if (res.ok) {
                        const d = await res.json();
                        const out = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
                        if (out) {
                            const text = String(out).trim().slice(0, maxChars);
                            context.reply(text).catch(() => {});
                            try {
                                bridge.send(new bridge.BridgeMsg(context, { text: '🤖 ' + text }));
                            } catch (e2) { /* 忽略 */ }
                            return;
                        }
                    }
                } catch (e2) {
                    winston.warn(`[aichat] fallback failed: ${e2.message}`);
                }
            }
            context.reply('（AI 出错了，稍后再试）').catch(() => {});
        });
    };

    for (let [type, handler] of pluginManager.handlers) {
        handler.addCommand('!ai', aiHandler);
    }
    winston.info('[aichat] !ai command registered on all handlers');
};
