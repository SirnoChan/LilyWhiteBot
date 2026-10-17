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

/**
 * 行內 markdown 解析：[text](url)、![alt](src)、**bold**、*em*、`code`
 */
const parseInline = (text, baseUrl) => {
    const nodes = [];
    const re = /!?\[([^\]]*)\]\(([^)\s]+)[^)]*\)|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\n]+)\*/gu;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) nodes.push(text.slice(last, m.index));
        if (m[0].startsWith('!')) {
            let src;
            try { src = new URL(m[2], baseUrl).toString(); } catch (e) { src = m[2]; }
            nodes.push({ tag: 'img', attrs: { src }, children: [] });
        } else if (m[2] !== undefined) {
            let href;
            try { href = new URL(m[2], baseUrl).toString(); } catch (e) { href = m[2]; }
            nodes.push({ tag: 'a', attrs: { href }, children: [m[1] || m[2]] });
        } else if (m[4] !== undefined) {
            nodes.push({ tag: 'strong', children: [m[4]] });
        } else if (m[6] !== undefined) {
            nodes.push({ tag: 'code', children: [m[6]] });
        } else if (m[5] !== undefined) {
            nodes.push({ tag: 'em', children: [m[5]] });
        }
        last = m.index + m[0].length;
    }
    if (last < text.length) nodes.push(text.slice(last));
    return nodes;
};

/**
 * jina markdown 轉 Telegraph 節點。
 * 輸入格式：頭部「Title: xxx」「URL Source: xxx」行，之後「Markdown Content:」正文。
 */
const markdownToNodes = (md, baseUrl) => {
    if (typeof md !== 'string') {
        throw new Error(`抓取結果異常：markdown 為 ${md === null ? 'null' : typeof md}（jina 返回類型需排查）`);
    }
    const titleMatch = md.match(/^Title:\s*(.+)$/mu);
    const title = titleMatch ? titleMatch[1].trim() : '';
    const body = md.includes('Markdown Content:') ? md.split(/^Markdown Content:\s*$/mu).pop() : md;

    const nodes = [];
    const lines = body.split('\n');
    let para = [];
    let list = null;        // 'ul' | 'ol' | null
    let inCode = false;
    let codeLines = [];

    const flushPara = () => {
        const text = para.join(' ').trim();
        para = [];
        if (!text) return;
        const inline = parseInline(text, baseUrl);
        nodes.push({ tag: 'p', children: inline.length ? inline : [text] });
    };
    let pendingListItems = [];
    const flushList = () => {
        if (pendingListItems.length) {
            nodes.push({ tag: list || 'ul', children: pendingListItems });
            pendingListItems = [];
            list = null;
        }
    };
    const addListItem = (text, tag) => {
        if (!list) list = tag || 'ul';
        const inline = parseInline(text, baseUrl);
        pendingListItems.push({ tag: 'li', children: inline.length ? inline : [text] });
    };

    for (let line of lines) {
        if (inCode) {
            if (/^```/u.test(line.trim())) {
                nodes.push({ tag: 'pre', children: [codeLines.join('\n')] });
                inCode = false; codeLines = [];
            } else {
                codeLines.push(line);
            }
            continue;
        }
        const trimmed = line.trim();
        if (/^```/u.test(trimmed)) { flushPara(); flushList(); inCode = true; continue; }
        if (trimmed === '') { flushPara(); flushList(); continue; }
        if (/^Title:\s|^URL Source:\s|^Published Time:/u.test(trimmed)) continue;

        let m;
        if ((m = trimmed.match(/^(#{1,6})\s+(.+)$/u))) { flushPara(); flushList(); nodes.push({ tag: m[1].length <= 3 ? 'h3' : 'h4', children: parseInline(m[2], baseUrl) }); continue; }
        if ((m = trimmed.match(/^!\[([^\]]*)\]\(([^)\s]+)[^)]*\)$/u))) { flushPara(); flushList(); let src; try { src = new URL(m[2], baseUrl).toString(); } catch (e) { src = m[2]; } nodes.push({ tag: 'img', attrs: { src }, children: [] }); continue; }
        if ((m = trimmed.match(/^[-*+]\s+(.*)$/u))) { flushPara(); if (list === 'ol') flushList(); addListItem(m[1], 'ul'); continue; }
        if ((m = trimmed.match(/^\d+[.)]\s+(.*)$/u))) { flushPara(); if (list === 'ul') flushList(); list = 'ol'; addListItem(m[1], 'ol'); continue; }
        if (/^>\s?/u.test(trimmed)) { flushPara(); flushList(); nodes.push({ tag: 'blockquote', children: parseInline(trimmed.replace(/^>\s?/u, ''), baseUrl) }); continue; }
        if (/^(-{3,}|\*{3,})$/u.test(trimmed)) { flushPara(); flushList(); nodes.push({ tag: 'hr', children: [] }); continue; }

        flushList();
        para.push(trimmed);
    }
    flushPara(); flushList();
    // li 必須掛在列表容器下：上面 addListItem 直接 push 了 li（Telegraph 允許頂層 li？不允許）——修正：li 由 addListItem 收集
    return { title, nodes };
};

const telegraphPlugin = (pluginManager, options) => {
    const tg = pluginManager.handlers.get('Telegram');

    if (!tg) {
        winston.error('[telegraph] Telegram handler not loaded, telegraph disabled.');
        return;
    }

    const authorName = options.authorName || 'LilyWhiteBot';
    const maxChars = options.maxChars === undefined ? 60000 : options.maxChars;
    const jinaFallback = options.jinaFallback !== false;
    const jinaApiKey = options.jinaApiKey || '';

    /**
     * 抓取页面 HTML。直接抓取失败（403 等反爬拦截）时，
     * 回退到 r.jina.ai（Jina Reader，住宅代理池，可绕过大部分站点反爬）。
     */
    const fetchPageHtml = async (pageUrl) => {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 20000);
            const res = await fetch(pageUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                },
                signal: controller.signal,
                redirect: 'follow',
            });
            clearTimeout(timer);
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            return { html: await res.text(), via: 'direct' };
        } catch (e) {
            if (!jinaFallback) throw e;
            winston.info(`[telegraph] direct fetch failed (${e.message}), trying r.jina.ai fallback`);
            const jinaFetch = async () => {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 90000);
                const headers = {};
                if (jinaApiKey) headers.Authorization = `Bearer ${jinaApiKey}`;
                const res = await fetch(`https://r.jina.ai/${pageUrl}`, {
                    headers,
                    signal: controller.signal,
                });
                clearTimeout(timer);
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status} (via r.jina.ai)`);
                }
                return res.text();
            };
            // jina 的 html 輸出模式對中文頁面有編碼 bug（輸出雙重編碼亂碼），
            // 改用默認的 markdown 輸出（中文正常），由 markdownToNodes 轉換；
            // 匿名請求對部分站點會 403，間隔後重試一次（有時命中 jina 內部緩存或換出口）
            let text;
            try {
                text = await jinaFetch();
            } catch (e1) {
                await new Promise(r => setTimeout(r, 3000));
                text = await jinaFetch();
            }
            if (typeof text !== 'string') {
                winston.error(`[telegraph] jina returned non-string: ${JSON.stringify(text)}`);
            }
            return { html: text, via: 'jina-markdown' };
        }
    };

    /**
     * 清洗署名：去掉「关于作者」前缀、回答/文章/关注者等统计数据尾巴，
     * 以及零宽字符。知乎等站点的作者卡片整块文本能被清理为纯昵称。
     */
    const cleanByline = (s) => {
        if (!s) return '';
        let t = s.replace(/[\u200b\u200c\u200d\ufeff]/gu, '').trim();
        t = t.replace(/^关于作者/, '');
        t = t.replace(/回答\d[\d,，]*\s*文章\d[\d,，]*[\s\S]*$/u, '');
        t = t.replace(/(?:关注[他她它]\s*)?发私信$/u, '');
        return t.trim();
    };

    /**
     * 从页面标题提取作者（知乎格式：「问题 - 作者 的回答」）。
     */
    const authorFromTitle = (docTitle) => {
        const m = (docTitle || '').match(/[-–—]\s*(.{1,30}?)\s*的回答\s*$/u);
        return m && m[1];
    };

    const convert = async (context, rawUrl) => {
        let url;
        try {
            url = new URL(rawUrl);
        } catch (e) {
            await tg.reply(context, '無效的鏈接。');
            return;
        }

        // 常見站點的顯示名（沒有映射的用域名）
        const SITE_NAMES = {
            'zhihu.com': '知乎', 'bilibili.com': '嗶哩嗶哩', 'weibo.com': '微博', 'weibo.cn': '微博',
            'mp.weixin.qq.com': '微信公眾平台', 'juejin.cn': '掘金', 'csdn.net': 'CSDN',
            'sspai.com': '少數派', 'github.com': 'GitHub', 'medium.com': 'Medium',
            'twitter.com': 'X', 'x.com': 'X', 'douban.com': '豆瓣', '36kr.com': '36氪',
        };
        const siteName = (() => {
            const host = url.hostname.replace(/^www\./iu, '');
            for (let domain in SITE_NAMES) {
                if (host === domain || host.endsWith('.' + domain)) return SITE_NAMES[domain];
            }
            return host;
        })();

        const notice = await tg.reply(context, '⏳ 正在抓取並轉換頁面…').catch(() => null);

        try {
            const { html, via } = await fetchPageHtml(url.toString());

            let article, jinaMarkdown = null, jinaTitle = '';
            const dom = new JSDOM(html, { url: url.toString() });
            article = new Readability(dom.window.document).parse();
            const docTitle = dom.window.document.title || '';

            // 頁面 meta 裏的作者署名（Readability 的 byline 缺失時從 meta 提取）
            const metaAuthor = (() => {
                const $h = cheerio.load(html);
                const m = $h('meta[property="article:author"]').attr('content')
                    || $h('meta[name="author"]').attr('content')
                    || $h('meta[name="twitter:creator"]').attr('content');
                return (m || '').trim();
            })();

            // jina 返回的已是提取後的 markdown 正文，Readability 失敗時直接轉換其 markdown
            if (!article || !article.content) {
                if (via === 'jina-markdown') {
                    jinaMarkdown = html;
                    jinaTitle = (html.match(/^Title:\s*(.+)$/mu) || [])[1] || '';
                    article = { title: jinaTitle, byline: '', content: '' };
                } else {
                    throw new Error('無法提取正文（頁面可能需要登錄或為動態渲染）');
                }
            }

            let nodes = (via === 'jina-markdown')
                ? markdownToNodes(jinaMarkdown, url.toString()).nodes
                : htmlToNodes(article.content, url.toString());
            if (via === 'jina-markdown' && !article.title) article.title = url.toString();

            // 截斷超長內容（Telegraph 限制 64KB）
            let size = JSON.stringify(nodes).length;
            if (maxChars > 0 && size > maxChars) {
                nodes = nodes.slice(0, Math.max(8, Math.floor(nodes.length * maxChars / size)));
                nodes.push('…（內容過長，已截斷）');
            }

            // 署名：原作者（原網站名），署名鏈接指向原文。
            // 作者優先級：頁面標題的知乎格式 > Readability/meta 的 byline（清洗後）> 網站名
            const byline = cleanByline(authorFromTitle(docTitle)
                || (article.byline && article.byline !== docTitle ? article.byline : '')
                || metaAuthor
                || ((jinaTitle.match(/[-–—]\s*(.{1,30}?)\s*的(?:回答|文章)\s*$/u) || [])[1] || ''));
            const authorLine = byline ? `${byline}（${siteName}）` : `${siteName}`;

            const acc = await loadAccount();
            const pageBody = new URLSearchParams({
                access_token: acc.access_token,
                title: (article.title || 'Untitled').slice(0, 250),
                author_name: authorLine.slice(0, 128),
                author_url: url.toString(),
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
            winston.warn(`[telegraph] conversion failed for ${rawUrl}: ${e.message}
${e.stack || ''}`);
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

module.exports = telegraphPlugin;
module.exports.markdownToNodes = markdownToNodes;
module.exports.parseInline = parseInline;
