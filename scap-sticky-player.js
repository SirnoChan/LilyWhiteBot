/*
 * scap-sticky-player.js — Compact Audio Player 跨页连续播放
 *
 * 访客在页面中点击 Compact Audio Player 的播放按钮后，播放状态（文件/进度）
 * 写入 sessionStorage；跳转到站点其他页面时，右下角出现可关闭的迷你播放条，
 * 从断点自动续播——音乐在整站浏览中不中断。
 * 集成 MediaSession API（系统媒体控制/锁屏显示）。
 *
 * 兼容: Compact Audio Player 插件的 SoundManager2 播放器（包装全局 play_mp3），
 *       同时支持页面上的原生 <audio> 元素。
 */
(function () {
    'use strict';

    var STATE_KEY = 'scap-sticky-state';

    var saveState = function (url, title, time) {
        try {
            sessionStorage.setItem(STATE_KEY, JSON.stringify({
                playing: true, url: url, title: title || url.split('/').pop(), time: time || 0
            }));
        } catch (e) { /* 忽略 */ }
    };

    var clearState = function () {
        try { sessionStorage.removeItem(STATE_KEY); } catch (e) { /* 忽略 */ }
    };

    var restoreState = function () {
        try {
            var raw = sessionStorage.getItem(STATE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    };

    /* ---------- 页面卸载时保存 sm2 / 原生 audio 的播放状态 ---------- */

    var collectPlaying = function () {
        // SoundManager2：全局 soundManager 对象的 sounds
        var found = null;
        try {
            if (typeof soundManager !== 'undefined' && soundManager.sounds) {
                for (var sid in soundManager.sounds) {
                    var s = soundManager.sounds[sid];
                    if (s && !s.paused && s.url) {
                        found = { url: s.url, time: s.position / 1000 };
                        break;
                    }
                }
            }
        } catch (e) { /* 忽略 */ }
        if (!found) {
            try {
                var audios = document.querySelectorAll('audio');
                for (var i = 0; i < audios.length; i++) {
                    if (!audios[i].paused && audios[i].currentSrc) {
                        found = { url: audios[i].currentSrc, time: audios[i].currentTime };
                        break;
                    }
                }
            } catch (e) { /* 忽略 */ }
        }
        return found;
    };

    window.addEventListener('pagehide', function () {
        var playing = collectPlaying();
        if (playing) {
            saveState(playing.url, document.title, playing.time);
        }
    });

    /* ---------- 跨页续播的迷你播放条 ---------- */

    var createStickyBar = function (url, title, resumeAt) {
        var audio = new Audio();
        audio.src = url;
        var bar = document.createElement('div');
        bar.id = 'scap-sticky-bar';
        bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:99998;' +
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
        });

        bar.appendChild(btn);
        bar.appendChild(titleEl);
        bar.appendChild(close);
        document.body.appendChild(bar);

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
        saveState(url, title, audio.currentTime);
    };

    /* ---------- 页面加载时检查是否需要续播 ---------- */

    document.addEventListener('DOMContentLoaded', function () {
        var st = restoreState();
        if (!st || !st.playing || !st.url) return;

        // 如果当前页面本身就渲染了这个音频的播放器（Compact Audio Player 短代码），
        // 页面上的 sm2 播放器会由访客自行控制，不需要 sticky 条
        var hasPlayerOnPage = document.querySelector('.compact_audio_player_wrapper') &&
            document.body.innerHTML.indexOf(st.url) !== -1;
        if (hasPlayerOnPage) return;

        createStickyBar(st.url, st.title, st.time);
    });
})();
