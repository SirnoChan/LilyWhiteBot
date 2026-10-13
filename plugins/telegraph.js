/*
 * telegraph.js 私聊文章轉 Telegraph 頁面
 *
 * 在 Telegram 私聊中發送 /telegraph <鏈接>（別名 /tgh），機器人會：
 * 1. 抓取目標網頁並提取正文（Mozilla Readability）；
 * 2. 轉換為 Telegraph 節點並發佈到 telegra.ph；
 * 3. 回覆 telegra.ph 鏈接——乾淨排版、無廣告、手機閱讀友好，
 *    不依賴 Instant View 模板，任何可抓取的網頁都能轉。
 *
 * Telegraph 帳號（access_token）在首次使用時自動創建並緩存到 data/。
 *
 * 配置（config.yml）：
 *
 * plugins:
 *   - telegraph
 *
 * telegraph:
 *   authorName: "LilyWhiteBot"     # Telegraph 頁面作者名
 *   maxChars: 60000                # 正文最大字符數（超長截斷），0 不限制
 */

'use strict';

const fs = require('fs');
const path = require('path');
const winston = require('winston');

// cheerio 1.2 的依赖引用 File 全局（Node 20+），Node 18 需补丁
if (typeof globalThis.File === 'undefined') {
    globalThis.File = class File extends Blob {};
}

const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const cheerio = require('cheerio');

const TELEGRAPH_API = 'https://api.telegra.ph';
const ALLOWED_TAGS = new Set(['a', 'aside', 'b', 'blockquote', 'br', 'code', 'em', 'figcaption',
    'figure', 'h3', 'h4', 'hr', 'i', 'iframe', 'img', 'li', 'ol', 'p', 'pre', 's', 'strong', 'u', 'ul', 'video']);

let account = null;      // { access_token, ... }
let accountFile = null;

const loadAccount = async () => {
    if (account) return account;

    accountFile = path.join(__dirname, 'data', 'telegraph-account.json');
    try {
        account = JSON.parse(fs.readFileSync(accountFile, 'utf8'));
        if (account.access_token) return account;
    } catch (e) { /* 無緩存，創建新帳號 */ }

    const res = await fetch(`${TELEGRAPH_API}/createAccount?short_name=LilyWhiteBot&author_name=LilyWhiteBot`);
    const data = await res.json();
    if (!data.ok) {
        throw new Error(`Telegraph createAccount failed: ${data.error}`);
    }
    account = data.result;
    fs.mkdirSync(path.dirname(accountFile), { recursive: true });
    fs.writeFileSync(accountFile, JSON.stringify(account, null, 2));
    winston.info('[telegraph] created Telegraph account');
    return account;
};

/**
 * 把 readability 產出的 HTML 轉為 Telegraph Node 數組
 */
const htmlToNodes = (html, baseUrl) => {
    const $ = cheerio.load(html);
    $('script, style, nav, header, footer, aside, form, iframe:not([src*="youtube"]), button, svg').remove();

    const abs = (el, attr) => {
        const v = el.attr(attr);
        if (!v) return undefined;
        try { return new URL(v, baseUrl).toString(); } catch (e) { return undefined; }
    };

    const convertChildren = (el) => {
        const nodes = [];
        for (const child of el.contents().toArray()) {
            if (child.type === 'text') {
                const t = String(child.nodeValue || '').replace(/\s+/gu, ' ');
                if (t.trim()) nodes.push(t);
                continue;
            }
            if (child.type !== 'tag') continue;

            const $c = $(child);
            let tag = $c.get(0).tagName.toLowerCase();
            let drop = false;

            switch (tag) {
                case 'h1': case 'h2': tag = 'h3'; break;
                case 'h5': case 'h6': tag = 'h4'; break;
                case 'b': tag = 'strong'; break;
                case 'i': tag = 'em'; break;
                case 'strike': case 'del': tag = 's'; break;
                case 'div': case 'span': case 'section': case 'article': case 'main':
                case 'header': case 'hgroup': case 'center': case 'font': case 'tbody':
                case 'thead': case 'tr': case 'td': case 'th': case 'table':
                    // 透明容器：提升子節點（table 類直接降級為文本內容）
                    if (['tbody', 'thead', 'tr', 'td', 'th', 'table'].includes(tag)) {
                        const txt = $c.text().replace(/\s+/gu, ' ').trim();
                        if (txt) nodes.push(txt);
                        drop = true;
                    } else {
                        nodes.push(...convertChildren($c));
                        drop = true;
                    }
                    break;
                case 'img': {
                    const src = abs($c, 'src') || abs($c, 'data-src');
                    if (!src) { drop = true; break; }
                    nodes.push({ tag: 'img', attrs: { src }, children: [] });
                    drop = true;
                    break;
                }
                case 'a': {
                    const href = abs($c, 'href');
                    const children = convertChildren($c);
                    if (!href) { nodes.push(...children); drop = true; break; }
                    nodes.push({ tag: 'a', attrs: { href }, children: children.length ? children : [href] });
                    drop = true;
                    break;
                }
                default:
                    break;
            }

            if (drop) continue;

            if (!ALLOWED_TAGS.has(tag)) {
                nodes.push(...convertChildren($c));
                continue;
            }

            const children = convertChildren($c);
            const attrs = {};
            if (tag === 'video' || tag === 'iframe') {
                const src = abs($c, 'src');
                if (src) attrs.src = src;
            }
            nodes.push({ tag, attrs, children });
        }
        return nodes;
    };

    return convertChildren($.root());
};

module.exports = (pluginManager, options) => {
    const tg = pluginManager.handlers.get('Telegram');

    if (!tg) {
        winston.error('[telegraph] Telegram handler not loaded, telegraph disabled.');
        return;
    }

    const authorName = options.authorName || 'LilyWhiteBot';
    const maxChars = options.maxChars === undefined ? 60000 : options.maxChars;

    const convert = async (context, rawUrl) => {
        let url;
        try {
            url = new URL(rawUrl);
        } catch (e) {
            await tg.reply(context, '無效的鏈接。');
            return;
        }

        const notice = await tg.reply(context, '⏳ 正在抓取並轉換頁面…').catch(() => null);

        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 20000);
            const res = await fetch(url.toString(), {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LilyWhiteBot-telegraph; +https://github.com/SirnoChan/LilyWhiteBot)' },
                signal: controller.signal,
                redirect: 'follow',
            });
            clearTimeout(timer);
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            const html = await res.text();

            const dom = new JSDOM(html, { url: url.toString() });
            const reader = new Readability(dom.window.document);
            const article = reader.parse();

            if (!article || !article.content) {
                throw new Error('無法提取正文（頁面可能需要登錄或為動態渲染）');
            }

            let nodes = htmlToNodes(article.content, url.toString());

            // 截斷超長內容（Telegraph 限制 64KB）
            let size = JSON.stringify(nodes).length;
            if (maxChars > 0 && size > maxChars) {
                nodes = nodes.slice(0, Math.max(8, Math.floor(nodes.length * maxChars / size)));
                nodes.push('…（內容過長，已截斷）');
            }

            const acc = await loadAccount();
            const pageBody = new URLSearchParams({
                access_token: acc.access_token,
                title: (article.title || 'Untitled').slice(0, 250),
                author_name: authorName,
                content: JSON.stringify(nodes),
                return_content: 'false',
            });
            const pageRes = await fetch(`${TELEGRAPH_API}/createPage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: pageBody.toString(),
            });
            const pageData = await pageRes.json();
            if (!pageData.ok) {
                throw new Error(`Telegraph: ${pageData.error}`);
            }

            const link = pageData.result.url;
            winston.info(`[telegraph] converted ${url} -> ${link}`);
            await tg.reply(context, `📄 ${article.title || ''}\n\n${link}`);
        } catch (e) {
            winston.warn(`[telegraph] conversion failed for ${rawUrl}: ${e.message}`);
            await tg.reply(context, `❌ 轉換失敗：${e.message}`).catch(() => {});
        } finally {
            if (notice) {
                try {
                    await tg._client.telegram.deleteMessage(context.from, notice.message_id);
                } catch (e) { /* 忽略 */ }
            }
        }
    };

    const handler = (context, cmd, param) => {
        if (!context.isPrivate) {
            return;
        }

        let url = param.trim();
        if (!url) {
            const m = context.text.match(/https?:\/\/[^\s<>"')\]]+/iu);
            url = m && m[0];
        }

        if (!url) {
            tg.reply(context, '用法：/telegraph <鏈接>\n例如 /telegraph https://example.com/article');
            return;
        }

        convert(context, url);
    };

    tg.addCommand('telegraph', handler);
    tg.addCommand('tgh', handler);
};
