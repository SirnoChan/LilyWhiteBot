/*
 * ai.js 通用 AI 摘要封裝（OpenAI 兼容 chat completions 接口）
 *
 * config.yml 頂層 ai 節：
 *
 * ai:
 *   apiBase: "https://api.openai.com/v1"   # OpenAI 兼容接口地址
 *   apiKey: ""                             # API Key
 *   model: "gpt-4o-mini"                   # 模型名
 *   visionModel: "gpt-4o"                  # 可選：帶圖片的轉發摘要用視覺模型（缺省用 model）
 *   visionApiBase: "..."                   # 可選：視覺模型單獨的接口地址（混搭別家免費視覺模型用）
 *   visionApiKey: "..."                    # 可選：視覺模型單獨的 API Key
 *   maxImages: 4                           # 可選：單次摘要最多送給模型的圖片數
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
        visionModel: options.visionModel || options.model,
        // 視覺模型可混搭別家（獨立端點/密鑰），未填則沿用主接口
        visionApiBase: options.visionApiBase ? options.visionApiBase.replace(/\/+$/u, '').replace(/\/chat\/completions$/u, '') : null,
        visionApiKey: options.visionApiKey || null,
        maxImages: options.maxImages > 0 ? Math.min(options.maxImages, 8) : 4,
    } : null;
    if (cfg) winston.info(`[ai] enabled (model: ${cfg.model}, vision: ${cfg.visionModel}${cfg.visionApiBase ? ' @ ' + cfg.visionApiBase : ''})`);
};

const aiAvailable = () => !!cfg;

/**
 * 生成合併轉發摘要。
 * entries: [{ nick, text, images?: [url, ...] }]
 * 帶圖片時改用視覺模型，圖片以 image_url 形式隨文本一併送出。
 * 返回摘要文本；失敗拋出異常，由調用方回退。
 */
const summarizeMergedForward = async (entries, maxChars = 1200) => {
    if (!cfg) throw new Error('AI not configured');

    const content = entries
        .map((e, i) => `${i + 1}. ${e.nick}: ${String(e.text).slice(0, 500)}`)
        .join('\n')
        .slice(0, maxChars);

    // 收集圖片：每條消息取第一張，輪詢到額度為止，兼顧覆蓋面
    const withImgs = entries.filter((e) => Array.isArray(e.images) && e.images.length);
    const images = [];
    for (let round = 0; round < 3 && images.length < cfg.maxImages; round++) {
        for (const e of withImgs) {
            if (e.images[round] && images.length < cfg.maxImages) {
                images.push(e.images[round]);
            }
        }
    }

    const systemPrompt = images.length
        ? '你是群聊助手。請用簡體中文把以下群聊合併轉發的內容（含圖片）總結成簡短摘要：概括文字要點，並簡要提及重要圖片的內容（如截圖主題、表情包含義）。控制在 150 字以內，直接輸出摘要本身，不要任何前言或解釋。'
        : '你是群聊助手。請用簡體中文把以下群聊合併轉發的內容總結成簡短摘要，保留關鍵信息和人物，控制在 150 字以內，直接輸出摘要本身，不要任何前言或解釋。';

    const userContent = images.length
        ? [{ type: 'text', text: content }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))]
        : content;

    const callChat = async (model, userContent, systemPrompt, vision = false) => {
        const apiBase = (vision && cfg.visionApiBase) || cfg.apiBase;
        const apiKey = (vision && cfg.visionApiKey) || cfg.apiKey;
        const res = await fetch(`${apiBase}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userContent },
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

    try {
        return await callChat(images.length ? cfg.visionModel : cfg.model, userContent, systemPrompt, images.length > 0);
    } catch (e) {
        // 視覺模型不可用（限流/欠費/名字錯）時，退回純文本摘要，圖片以佔位標記
        if (!images.length) throw e;
        winston.warn(`[ai] vision call failed (${e.message}), retrying text-only`);
        const textOnly = entries
            .map((e, i) => `${i + 1}. ${e.nick}: ${String(e.text).slice(0, 500)}${Array.isArray(e.images) && e.images.length ? ' [图片x' + e.images.length + ']' : ''}`)
            .join('\n')
            .slice(0, maxChars);
        return await callChat(cfg.model, textOnly,
            '你是群聊助手。請用簡體中文把以下群聊合併轉發的內容總結成簡短摘要，保留關鍵信息和人物，控制在 150 字以內，直接輸出摘要本身，不要任何前言或解釋。');
    }
};

module.exports = { init, aiAvailable, summarizeMergedForward };
