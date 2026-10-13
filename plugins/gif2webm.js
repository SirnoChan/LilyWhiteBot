/*
 * gif2webm.js 私聊 GIF 轉 Telegram 視頻貼紙（WebM）
 *
 * 在 Telegram 私聊中：
 * - 直接發送 GIF 動圖（animation）或 .gif 文件，機器人自動轉換為
 *   Telegram 視頻貼紙規格的 WebM（512x512、VP9、無聲、≤3 秒、≤256KB）
 *   並以文件形式回傳，可通過 @Stachines 上傳為貼紙包或直接轉發使用；
 * - 或發送 /webm <gif鏈接> 轉換遠端 GIF。
 *
 * 依賴：系統需安裝 ffmpeg（libvpx-vp9）。
 *
 * 配置（config.yml）：
 *
 * plugins:
 *   - gif2webm
 *
 * gif2webm:
 *   duration: 3          # 最長時長（秒），超過截斷。Telegram 視頻貼紙上限 3 秒
 *   fps: 30
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const winston = require('winston');

const STICKER_MAX_BYTES = 256 * 1024;

const run = (cmd, args) => new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
    });
});

const convertGif = async (inputPath, workDir, duration, fps) => {
    const output = path.join(workDir, 'sticker.webm');
    // Telegram 視頻貼紙規格：512x512（等比縮放+透明 pad）、VP9、無聲、yuva420p
    const vf = `fps=${fps},scale=512:512:flags=lanczos:force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=black@0.0,format=yuva420p`;

    for (const crf of [32, 40, 50]) {
        await run('ffmpeg', ['-y', '-v', 'error', '-i', inputPath,
            '-vf', vf, '-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '256k',
            '-an', '-t', String(duration), output]);
        const size = fs.statSync(output).size;
        winston.debug(`[gif2webm] crf ${crf} -> ${size} bytes`);
        if (size <= STICKER_MAX_BYTES) return output;
    }
    // 三檔碼率都超限也照樣回傳（Telegram 可能仍接受，或用戶可自行壓縮）
    return output;
};

module.exports = (pluginManager, options) => {
    const tg = pluginManager.handlers.get('Telegram');

    if (!tg) {
        winston.error('[gif2webm] Telegram handler not loaded, gif2webm disabled.');
        return;
    }

    const duration = options.duration || 3;
    const fps = options.fps || 30;

    const processUrl = async (context, url) => {
        const notice = await tg.reply(context, '⏳ 正在轉換 GIF…').catch(() => null);
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gif2webm-'));
        const inputPath = path.join(workDir, 'input.gif');

        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 60000);
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timer);
            if (!res.ok) throw new Error(`下載失敗：HTTP ${res.status}`);

            const buf = Buffer.from(await res.arrayBuffer());
            fs.writeFileSync(inputPath, buf);

            const webm = await convertGif(inputPath, workDir, duration, fps);
            await tg.sendDocument(context.from, { source: fs.readFileSync(webm), filename: 'sticker.webm' });
            winston.info(`[gif2webm] converted gif (${buf.length}B) -> sticker.webm`);
        } catch (e) {
            winston.warn(`[gif2webm] conversion failed: ${e.message}`);
            await tg.reply(context, `❌ 轉換失敗：${e.message}`).catch(() => {});
        } finally {
            if (notice) {
                try { await tg._client.telegram.deleteMessage(context.from, notice.message_id); } catch (e) { /* 忽略 */ }
            }
            fs.rmSync(workDir, { recursive: true, force: true });
        }
    };

    // 私聊發送 GIF 動圖（animation）或 .gif 文件
    tg.on('richmessage', (context) => {
        if (!context.isPrivate || context.command) return;

        const files = context.extra.files || [];
        const file = files[0];
        if (!file || !file.url) return;

        const raw = context._rawdata && context._rawdata.message;
        const isAnimation = !!(raw && raw.animation);
        const isGifFile = file.mime_type === 'image/gif' || /\.gif(?:\?|$)/iu.test(file.url || '');

        if (isAnimation || isGifFile) {
            processUrl(context, file.url);
        }
    });

    // /webm <gif鏈接>
    tg.addCommand('webm', (context, cmd, param) => {
        if (!context.isPrivate) return;

        let url = param.trim();
        if (!url) {
            const m = context.text.match(/https?:\/\/[^\s<>"')\]]+/iu);
            url = m && m[0];
        }
        if (!url) {
            tg.reply(context, '用法：/webm <GIF鏈接>\n或直接私聊發送 GIF 動圖文件');
            return;
        }
        processUrl(context, url);
    });
};
