/*
 * linkclean.js 展開短鏈並清理訊息中連結的追蹤參數（保護群友隱私）
 *
 * 功能：
 * 1. 展開短鏈（b23.tv、t.cn 等）為真實網址；
 * 2. 清理網址中的追蹤參數（utm_*、B站的 share_source/spm_id_from、微博的 from/rid 等）。
 *
 * 配置（config.yml）：
 *
 * plugins:
 *   - linkclean
 *
 * linkclean:
 *   expandShortlinks: true                # 是否展開短鏈
 *   timeout: 5000                         # 展開短鏈的超時（毫秒）
 *   shortDomains: []                      # 追加自訂短鏈域名（與內建清單合併）
 *   trackingParams: []                    # 追加自訂追蹤參數名（與內建清單合併）
 *   domains:                              # 按域名自訂參數處理（可覆蓋黑名單行為）
 *     "example.com":
 *       drop: ["sid", "ref"]              # 該域名下要刪除的參數
 *       keep: []                          # 該域名下白名單之外全刪（與 drop 互斥使用）
 */

'use strict';

const winston = require('winston');

// 內建短鏈域名
const BUILTIN_SHORT_DOMAINS = [
    'b23.tv',        // bilibili
    'bilibili.com/short', // bilibili 舊短鏈
    't.cn',          // 微博
    'url.cn',        // 騰訊
    'c.tb.cn',       // 淘寶
    'bit.ly',
    'tinyurl.com',
    'is.gd',
    'dwz.cn',        // 百度
];

// 內建追蹤參數黑名單（所有域名生效）
// 注意：只放含義明確的追蹤參數；過於通用的名字（如 s、from）放在下面 BUILTIN_DOMAIN_RULES
const BUILTIN_TRACKING_PARAMS = [
    // 通用
    'share_id', 'share_from', 'share_channel', 'share_medium', 'share_plat',
    'share_source', 'share_tag', 'share_session_id', 'shareuserid',
    'sessionid', 'session_id', 'refer_flag', 'refer_from', 'referrer',
    'ref_src', 'ref_url', 'track_id', 'trackid', 'trace', 'fr',
    // bilibili
    'spm_id_from', 'spm', 'bbid', 'ts', 'unique_k', 'up_id', 'up_name',
    'vd_source', 'launchid', 'live_source', 'broadcast_type', 'is_room_feed',
    // 其他常見
    'si', 'feature', 'app', 'is_all', 'is_hot', 'dt_dapp', 'dt_pc',
    'xptdk', 'scm', 'pdt', 'pdist', 'scene',
];

// 按域名的內建規則
// keep：白名單之外的參數全刪（適合分享連結垃圾參數成堆的站點）
// drop：只刪列出的參數（適合過於通用、不能全域生效的參數名）
const BUILTIN_DOMAIN_RULES = {
    'bilibili.com': { keep: ['p', 't'] },  // 只保留分P與跳轉時間；buvid/spmid/from_spmid/mid/plat_id/timestamp 等全刪
    'weibo.com': { keep: [] },
    'weibo.cn': { keep: [] },
    'xiaohongshu.com': { keep: ['xsec_token', 'xsec_source'] },
    'douyin.com': { keep: ['modal_id', 'previous_page'] },
    'youtube.com': { keep: ['v', 't', 'list', 'index', 'start'] },
    'youtu.be': { keep: ['t'] },
    'x.com': { keep: [] },
    'twitter.com': { keep: [] },
    'zhihu.com': { keep: [] },
};

const UTM_PREFIX = /^utm_/iu;

// 從訊息中提取 URL（排除常見中文標點，避免吞掉後文）
const URL_REGEX = /(https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+)/gu;

const isUrl = (s) => {
    try {
        const u = new URL(s);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (e) {
        return false;
    }
};

/**
 * 清理網址中的追蹤參數，返回清理後的網址；無變化時返回 null
 */
const cleanUrl = (rawUrl, trackingParams, domainRules) => {
    if (!isUrl(rawUrl)) {
        return null;
    }

    let u;
    try {
        u = new URL(rawUrl);
    } catch (e) {
        return null;
    }

    // 按域名找規則
    let dropList = null;
    let keepList = null;
    if (domainRules) {
        for (let domain in domainRules) {
            if (u.hostname === domain || u.hostname.endsWith('.' + domain)) {
                if (domainRules[domain].drop) {
                    dropList = domainRules[domain].drop;
                }
                if (domainRules[domain].keep) {
                    keepList = domainRules[domain].keep;
                }
                break;
            }
        }
    }

    let changed = false;
    for (let key of [...u.searchParams.keys()]) {
        let shouldDrop;
        if (keepList) {
            shouldDrop = !keepList.includes(key);
        } else if (dropList) {
            shouldDrop = dropList.includes(key);
        } else {
            shouldDrop = trackingParams.includes(key) || UTM_PREFIX.test(key);
        }

        if (shouldDrop) {
            u.searchParams.delete(key);
            changed = true;
        }
    }

    if (!changed) {
        return null;
    }

    let cleaned = u.toString();
    // URL.toString() 對空 query 會留下尾部 '?'，去掉
    return cleaned.replace(/\?$/u, '') === rawUrl.replace(/\?$/u, '') ? null : cleaned.replace(/\?$/u, '');
};

/**
 * 展開短鏈：跟隨重新導向取最終網址；失敗返回 null
 */
const expandShortlink = async (url, timeout, userAgent) => {
    const headers = { 'User-Agent': userAgent };

    try {
        const res = await fetch(url, {
            method: 'HEAD',
            redirect: 'follow',
            headers: headers,
            signal: AbortSignal.timeout(timeout),
        });
        if (res.url && res.url !== url) {
            return res.url;
        }
    } catch (e) { /* HEAD 不被支援時繼續嘗試 GET */ }

    try {
        const res = await fetch(url, {
            redirect: 'follow',
            headers: headers,
            signal: AbortSignal.timeout(timeout),
        });
        // 不讀取正文，立即取消
        try { if (res.body) await res.body.cancel(); } catch (e) { /* 忽略 */ }
        if (res.url && res.url !== url) {
            return res.url;
        }
    } catch (e) { /* 忽略 */ }

    return null;
};

module.exports = (pluginManager, options) => {
    const bridge = pluginManager.plugins.transport;

    if (!bridge) {
        winston.error('[linkclean] Transport plugin not loaded, linkclean disabled.');
        return;
    }

    const shortDomains = [...BUILTIN_SHORT_DOMAINS, ...(options.shortDomains || [])];
    const trackingParams = [...BUILTIN_TRACKING_PARAMS, ...(options.trackingParams || [])];
    // 使用者域名規則優先於內建規則（按域名覆蓋）
    const domainRules = Object.assign({}, BUILTIN_DOMAIN_RULES, options.domains || {});
    const expandEnabled = options.expandShortlinks !== false;
    const timeout = options.timeout || 5000;
    const userAgent = options.userAgent || 'Mozilla/5.0 (compatible; LilyWhiteBot-linkclean)';

    const isShortLink = (url) => {
        try {
            const host = new URL(url).hostname.toLowerCase();
            return shortDomains.some(d => host === d.toLowerCase() || host.endsWith('.' + d.toLowerCase()));
        } catch (e) {
            return false;
        }
    };

    bridge.addHook('bridge.send', async (msg) => {
        if (!msg.text || typeof msg.text !== 'string') {
            return;
        }

        const urls = msg.text.match(URL_REGEX);
        if (!urls || urls.length === 0) {
            return;
        }

        const uniqueUrls = [...new Set(urls)];
        const replacements = new Map();

        await Promise.all(uniqueUrls.map(async (url) => {
            let finalUrl = url;

            if (expandEnabled && isShortLink(url)) {
                const expanded = await expandShortlink(url, timeout, userAgent);
                if (expanded) {
                    finalUrl = expanded;
                }
            }

            const cleaned = cleanUrl(finalUrl, trackingParams, domainRules);
            if (cleaned) {
                finalUrl = cleaned;
            }

            if (finalUrl !== url) {
                replacements.set(url, finalUrl);
            }
        }));

        if (replacements.size > 0) {
            let text = msg.text;
            for (let [from, to] of replacements) {
                text = text.split(from).join(to);
            }
            winston.info(`[linkclean] Rewrote ${replacements.size} link(s) in #${msg.msgId}`);
            winston.debug(`[linkclean] ${[...replacements.entries()].map(([f, t]) => `${f} -> ${t}`).join(' ; ')}`);
            msg.text = text;
        }
    });
};
