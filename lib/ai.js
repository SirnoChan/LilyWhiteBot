/*
 * ai.js 通用 AI 摘要封裝（OpenAI 兼容 chat completions 接口）
 *
 * config.yml 頂層 ai 節：
 *
 * ai:
 *   apiBase: "https://api.openai.com/v1"   # OpenAI 兼容接口地址
 *   apiKey: ""                             # API Key
 *   model: "gpt-4o-mini"                   # 模型名
 *
 * 未配置 apiKey 時 aiAvailable 為 false，調用方回退到非 AI 邏輯。
 */

'use strict';

const winston = require('winston');

let cfg = null;

const init = (options = {}) => {
    cfg = (options.apiKey && options.model) ? {
        // 兼容两种填法：基础地址（.../v1）或完整端点（.../chat/completions）
        apiBase: (options.apiBase || 'https://api.openai.com/v1').replace(/\/+$/u, '').replace(/\/chat\/completions$/u, ''),
        apiKey: options.apiKey,
        model: options.model,
    } : null;
    if (cfg) winston.info(`[ai] enabled (model: ${cfg.model})`);
};

const aiAvailable = () => !!cfg;

/**
 * 生成合併轉發摘要。
 * entries: [{ nick, text }]，text 為單條消息內容
 * 返回摘要文本；失敗拋出異常，由調用方回退。
 */
const summarizeMergedForward = async (entries, maxChars = 1200) => {
    if (!cfg) throw new Error('AI not configured');

    const content = entries
        .map((e, i) => `${i + 1}. ${e.nick}: ${String(e.text).slice(0, 500)}`)
        .join('\n')
        .slice(0, maxChars);

    const res = await fetch(`${cfg.apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
            model: cfg.model,
            messages: [
                { role: 'system', content: '你是群聊助手。請用簡體中文把以下群聊合併轉發的內容總結成簡短摘要，保留關鍵信息和人物，控制在 150 字以內，直接輸出摘要本身，不要任何前言或解釋。' },
                { role: 'user', content },
            ],
            temperature: 0.3,
        }),
        signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
        throw new Error(`AI HTTP ${res.status}`);
    }
    const data = await res.json();
    const out = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!out) throw new Error('AI 返回空');
    return out.trim();
};

module.exports = { init, aiAvailable, summarizeMergedForward };
