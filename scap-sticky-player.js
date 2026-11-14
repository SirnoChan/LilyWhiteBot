/*
 * scap-sticky-player.js — Compact Audio Player 跨页连续播放
 *
 * 访客在页面中点击播放按钮后，播放状态（文件/进度/标题）写入 cookie；
 * 跳转到站点其他页面时，左下角出现可关闭的迷你播放条，从断点自动续播
 * ——音乐在整站浏览中不中断。集成 MediaSession API（系统媒体控制/锁屏）。
 *
 * 兼容三类音频来源：
 *  1. Compact Audio Player 的 SoundManager2 播放器（soundManager.sounds）
 *  2. 页面上的原生 <audio> 元素（含 APlayer 容器内的）
 *  3. APlayer 等创建后不插入 DOM 的 JS 播放器音频 —— 通过 hook
 *     document.createElement / new Audio() 收集（本脚本在 <head>，
 *     早于任何播放器库实例化）
 */
(function () {
    'use strict';

    var STATE_KEY = 'scap-sticky-state';
    // cookie 而非 sessionStorage：状态需跨子域共享（hourai.xyz/blog 与 wiki.hourai.xyz）
    var COOKIE_CFG = 'domain=.hourai.xyz; path=/; max-age=86400';  // 1 天自动过期

    var saveState = function (url, title, time) {
        // URL 转相对路径（同源断点续播）
        var u;
        try { u = new URL(url, location.origin); } catch (e) { return; }
        var rel = u.pathname + u.search;
        document.cookie = STATE_KEY + '=' + encodeURIComponent(JSON.stringify({
            playing: 1, url: rel, title: String(title || ''), time: Math.floor(time || 0)
        })) + '; ' + COOKIE_CFG;
    };

    var clearState = function () {
        document.cookie = STATE_KEY + '=; ' + COOKIE_CFG.replace('max-age=86400', 'max-age=0');
    };

    var restoreState = function () {
        var m = document.cookie.match(new RegExp('(^| )' + STATE_KEY + '=([^;]*)'));
        try {
            var st = m ? JSON.parse(decodeURIComponent(m[2])) : null;
            return (st && st.playing && st.url) ? st : null;
        } catch (e) { return null; }
    };

    /* ---------- 立即执行的 audio 收集 hook ----------
     * APlayer 用 document.createElement('audio')（或 new Audio()）创建音频
     * 对象后从不 appendChild，querySelectorAll('audio') 找不到它们。
     * 这里替换创建入口，把创建出的每个 audio 收进 trackedAudios。 */
    var trackedAudios = [];

    // 页面上的其他播放器开始播放时，暂停 sticky 条，避免两路声音重叠
    var stickyPause = null;
    var onForeignPlay = function () {
        if (stickyPause) { try { stickyPause(); } catch (e) { /* 忽略 */ } }
    };

    (function hookAudioCreation() {
        try {
            var origCreate = document.createElement.bind(document);
            document.createElement = function (tag) {
                var el = origCreate.apply(null, arguments);
                try {
                    if (el && String(el.tagName).toUpperCase() === 'AUDIO') {
                        trackedAudios.push(el);
                        el.addEventListener('play', onForeignPlay);
                    }
                } catch (e) { /* 忽略 */ }
                return el;
            };
            var OrigAudio = window.Audio;
            var HookedAudio = function (src) {
                var a = src !== undefined ? new OrigAudio(src) : new OrigAudio();
                try {
                    trackedAudios.push(a);
                    a.addEventListener('play', onForeignPlay);
                } catch (e) { /* 忽略 */ }
                return a;
            };
            HookedAudio.prototype = OrigAudio.prototype;
            window.Audio = HookedAudio;
        } catch (e) { /* 忽略 */ }
    })();

    /* ---------- 页面卸载时保存正在播放的音频状态 ---------- */

    var collectPlaying = function () {
        var found = null, i, el, src;
        // hook 收集的 audio（APlayer 等，含不插入 DOM 的）
        for (i = 0; i < trackedAudios.length; i++) {
            el = trackedAudios[i];
            src = el.currentSrc || el.src;
            if (el && !el.paused && src) {
                found = { url: src, time: el.currentTime };
                break;
            }
        }
        // DOM 里的原生 <audio>
        if (!found) {
            var audios = document.querySelectorAll('audio');
            for (i = 0; i < audios.length; i++) {
                if (!audios[i].paused && audios[i].currentSrc) {
                    found = { url: audios[i].currentSrc, time: audios[i].currentTime };
                    break;
                }
            }
        }
        // SoundManager2（Compact Audio Player 本体）
        if (!found && typeof soundManager !== 'undefined' && soundManager.sounds) {
            for (var sid in soundManager.sounds) {
                var s = soundManager.sounds[sid];
                if (s && !s.paused && s.url) {
                    found = { url: s.url, time: s.position / 1000 };
                    break;
                }
            }
        }
        return found;
    };

    var pageTitle = function () {
        // APlayer 的当前曲名（.aplayer-music 内，随切歌更新）优先于页面标题
        var t = document.querySelector('.aplayer-music .aplayer-title');
        if (t && t.textContent) return t.textContent;
        return document.title;
    };

    // 本页面 sticky 条自己的音频（等自动播放放行/被暂停时也需保留状态）
    var stickyAudio = null, stickyUrl = null, stickyTitle = null;

    window.addEventListener('pagehide', function () {
        var playing = collectPlaying();
        if (playing) {
            saveState(playing.url, pageTitle(), playing.time);
            console.error('[scap-sticky] saved:', playing.url, Math.floor(playing.time) + 's');
        } else if (stickyAudio && stickyUrl) {
            // sticky 条存在但未出声（自动播放被拦/被暂停）：
            // 保留断点，让下一个页面继续尝试恢复，而不是把音乐链清断
            saveState(stickyUrl, stickyTitle, stickyAudio.currentTime || 0);
            console.error('[scap-sticky] saved pending state:', stickyUrl);
        } else {
            clearState();
            console.error('[scap-sticky] nothing playing, state cleared');
        }
    });

    /* ---------- 跨页续播的迷你播放条 ---------- */

    var createStickyBar = function (url, title, resumeAt) {
        var full;
        try { full = new URL(url, location.origin).toString(); } catch (e) { full = url; }
        var audio = new Audio();
        audio.src = full;
        stickyAudio = audio;
        stickyUrl = url;
        stickyTitle = title;
        var bar = document.createElement('div');
        bar.id = 'scap-sticky-bar';
        bar.style.cssText = 'position:fixed;bottom:0;left:0;width:280px;z-index:99998;' +
            'background:rgba(30,30,30,0.92);color:#eee;padding:8px 14px;' +
            'font-size:13px;display:flex;align-items:center;gap:10px;' +
            'box-shadow:0 -2px 8px rgba(0,0,0,0.3);font-family:sans-serif;';

        var btn = document.createElement('button');
        btn.textContent = '⏸';
        btn.style.cssText = 'background:none;border:none;color:#eee;font-size:16px;cursor:pointer;padding:2px 6px;';
        btn.addEventListener('click', function () {
            if (audio.paused) { audio.play(); btn.textContent = '⏸'; }
            else { audio.pause(); btn.textContent = '▶'; }
        });

        var titleEl = document.createElement('span');
        titleEl.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        titleEl.textContent = '🎵 ' + title;

        var close = document.createElement('span');
        close.textContent = '✕';
        close.style.cssText = 'cursor:pointer;color:#aaa;padding:2px 6px;';
        close.title = '关闭音乐';
        close.addEventListener('click', function () {
            audio.pause();
            clearState();
            bar.remove();
            stickyPause = null;
            stickyAudio = null;
            stickyUrl = null;
        });

        bar.appendChild(btn);
        bar.appendChild(titleEl);
        bar.appendChild(close);
        document.body.appendChild(bar);

        stickyPause = function () {
            if (!audio.paused) { audio.pause(); btn.textContent = '▶'; }
        };

        audio.addEventListener('loadedmetadata', function () {
            if (resumeAt > 0 && resumeAt < audio.duration) {
                try { audio.currentTime = resumeAt; } catch (e) { /* 忽略 */ }
            }
        });
        audio.addEventListener('play', function () {
            btn.textContent = '⏸';
            if ('mediaSession' in navigator && title) {
                try {
                    navigator.mediaSession.metadata = new MediaMetadata({ title: title, artist: 'Music' });
                    navigator.mediaSession.setActionHandler('play', function () { audio.play(); });
                    navigator.mediaSession.setActionHandler('pause', function () { audio.pause(); });
                } catch (e) { /* 忽略 */ }
            }
        });
        audio.addEventListener('ended', function () {
            clearState();
            bar.remove();
            stickyPause = null;
            stickyAudio = null;
            stickyUrl = null;
        });
        audio.addEventListener('timeupdate', function () {
            if (Math.floor(audio.currentTime) % 5 === 0) saveState(url, title, audio.currentTime);
        });
        audio.play().catch(function () {
            // 自动播放被拦截：提示点击恢复
            btn.textContent = '▶';
            document.addEventListener('click', function once() {
                document.removeEventListener('click', once);
                audio.play().catch(function () {});
                btn.textContent = '⏸';
            });
        });
        saveState(url, title, resumeAt || 0);
    };

    /* ---------- 页面加载时检查是否需要续播 ---------- */

    document.addEventListener('DOMContentLoaded', function () {
        var st = restoreState();
        console.error('[scap-sticky] restore:', st ? (st.title + ' @' + st.time + 's') : 'none');
        if (!st) return;
        // 不检查当前页是否已有播放器：即使跳回原页面，页面播放器也不会自动
        // 续播，sticky 条的自动接续才是"跨页不中断"的保证
        createStickyBar(st.url, st.title || document.title, st.time || 0);
    });
})();
