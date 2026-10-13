/*
 * @name 使用通用介面處理 LINE 訊息
 *
 * 基於 LINE Messaging API（官方）：
 * - Webhook 接收（HTTP server，含 X-Line-Signature 簽名驗證）
 * - Push API 發送（https://api.line.me/v2/bot/message/push）
 *
 * 限制（LINE 平台特性）：
 * - 群組 ID 以 'C' 開頭；bot 需被邀請進群並開啟「允許群組加入」
 * - 文字訊息上限 5000 字符
 * - 圖片/影片/語音以 URL 形式發送（LINE 伺服器自行抓取，需公網 https URL）
 * - LINE 不支援接收時獲取自己發出的訊息，因此跨平台回復引用在 LINE 端不可用
 * - Push 訊息有月度免費額度（免費檔 200 則/月），超額需付費
 */

const MessageHandler = require('./MessageHandler.js');
const Context = require('./Context.js');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LRUCache } = require('lru-cache');
const winston = require('winston');
const { getFriendlySize } = require('../util.js');

const LINE_API = 'https://api.line.me/v2/bot';

// content 類型對應副檔名
const CONTENT_EXT = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'audio/m4a': '.m4a',
};

class LineMessageHandler extends MessageHandler {
    constructor(config = {}) {
        super();

        const botConfig = config.bot || {};
        const lineOptions = config.options || {};

        if (!botConfig.channelAccessToken || !botConfig.channelSecret) {
            throw new Error('Line bot config error: channelAccessToken and channelSecret are required.');
        }

        this._type = 'Line';
        this._id = 'L';

        this._accessToken = botConfig.channelAccessToken;
        this._channelSecret = botConfig.channelSecret;
        this._host = (botConfig.listen && botConfig.listen.host) || '0.0.0.0';
        this._port = (botConfig.listen && botConfig.listen.port) || 11340;
        this._path = (botConfig.listen && botConfig.listen.path) || '/line-webhook';
        this._nickStyle = lineOptions.nickStyle || 'displayname';
        this._keepSilence = lineOptions.keepSilence || [];
        this._maxTextLength = lineOptions.maxTextLength || 5000;

        // webhook 事件去重（LINE 可能重發）
        this._seenEvents = new LRUCache({ max: 1000, ttl: 5 * 60 * 1000 });
        // userId -> displayname 緩存
        this._displayNames = new LRUCache({ max: 500, ttl: 3600 * 1000 });
        this._startTime = 0;

        this._server = http.createServer((req, res) => this._handleWebhook(req, res));
    }

    _handleWebhook(req, res) {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{}');

            try {
                const signature = crypto
                    .createHmac('SHA256', this._channelSecret)
                    .update(body)
                    .digest('base64');
                if ((req.headers['x-line-signature'] || '') !== signature) {
                    winston.warn('[LineBot] webhook signature mismatch');
                    return;
                }

                const payload = JSON.parse(body);
                for (const event of (payload.events || [])) {
                    if (this._seenEvents.has(event.webhookEventId)) continue;
                    this._seenEvents.set(event.webhookEventId, true);
                    this._processEvent(event).catch(e => {
                        winston.error(`[LineBot] event processing failed: ${e.message}`);
                    });
                }
            } catch (e) {
                winston.error(`[LineBot] webhook handling failed: ${e.message}`);
            }
        });
    }

    async _api(method, endpoint, body) {
        const res = await fetch(LINE_API + endpoint, {
            method,
            headers: {
                'Authorization': `Bearer ${this._accessToken}`,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`LINE API ${endpoint}: HTTP ${res.status} ${text.slice(0, 150)}`);
        }
        return res.json().catch(() => ({}));
    }

    async _resolveNick(userId, isGroup) {
        if (this._nickStyle === 'userid' || !userId) return userId || '';
        if (this._displayNames.has(userId)) return this._displayNames.get(userId) || userId;
        try {
            // 群內成員暱稱需群組 ID，此處用通用 profile；失敗退回 userId
            const profile = await this._api('GET', `/profile/${userId}`);
            const name = (profile && profile.displayName) || userId;
            this._displayNames.set(userId, name);
            return name;
        } catch (e) {
            return userId;
        }
    }

    async _processEvent(event) {
        // 忽略啟動前的舊事件
        if (this._startTime && event.timestamp && event.timestamp < this._startTime) return;

        if (event.type !== 'message' || !event.source || event.source.type !== 'group') {
            return;  // 只處理群組訊息
        }

        const groupId = event.source.groupId;
        const userId = event.source.userId;
        const message = event.message;
        if (!message) return;

        let context;
        const nick = await this._resolveNick(userId, true);

        if (message.type === 'text') {
            context = new Context({
                from: userId, to: groupId, nick,
                text: message.text || '', isPrivate: false,
                extra: {}, handler: this, _rawdata: event,
            });
        } else if (message.type === 'image' || message.type === 'video' || message.type === 'audio') {
            const typeLabel = message.type === 'image' ? 'Image' : (message.type === 'video' ? 'Video' : 'Audio');
            context = new Context({
                from: userId, to: groupId, nick,
                text: `<${typeLabel}>`, isPrivate: false,
                extra: {}, handler: this, _rawdata: event,
            });
            // 下載媒體到本機，file.js 會上傳圖床後以 URL 轉發
            try {
                const res = await fetch(`${LINE_API}/message/${message.id}/content`, {
                    headers: { 'Authorization': `Bearer ${this._accessToken}` },
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const buf = Buffer.from(await res.arrayBuffer());
                const ext = CONTENT_EXT[res.headers.get('content-type')] || (message.type === 'image' ? '.jpg' : message.type === 'video' ? '.mp4' : '.m4a');
                const file = path.join(os.tmpdir(), `line-${message.id}${ext}`);
                fs.writeFileSync(file, buf);
                context.extra.files = [{
                    client: 'Line', type: typeLabel.toLowerCase(),
                    id: message.id, size: buf.length, path: file,
                }];
                context.text = `<${typeLabel}: ${getFriendlySize(buf.length)}>`;
            } catch (e) {
                winston.warn(`[LineBot] failed to download ${typeLabel} content: ${e.message}`);
            }
        } else if (message.type === 'sticker') {
            context = new Context({
                from: userId, to: groupId, nick,
                text: `<Sticker ${message.stickerId}>`, isPrivate: false,
                extra: {}, handler: this, _rawdata: event,
            });
        } else {
            return;  // location/file 等類型暫不處理
        }

        // 命令檢查（與其他平台相同的前綴式命令）
        for (const [cmd, callback] of this._commands) {
            if (context.text.startsWith(cmd)) {
                let param = context.text.trim().substring(cmd.length);
                if (param === '' || param.startsWith(' ')) {
                    param = param.trim();
                    context.command = cmd;
                    context.param = param;
                    if (typeof callback === 'function') callback(context, cmd, param);
                    this.emit('command', context, cmd, param);
                    this.emit(`command#${cmd}`, context, param);
                }
            }
        }

        this.emit('text', context);
    }

    splitText(text, maxLength = 5000) {
        const parts = [];
        let rest = String(text);
        while (rest.length > maxLength) {
            parts.push(rest.slice(0, maxLength));
            rest = rest.slice(maxLength);
        }
        parts.push(rest);
        return parts;
    }

    async say(target, message, options = {}) {
        if (!this._enabled) {
            throw new Error('Handler not enabled');
        }
        if (this._keepSilence.indexOf(target) !== -1) {
            return;
        }

        const parts = this.splitText(message, this._maxTextLength);
        let last;
        for (const part of parts) {
            last = await this._api('POST', '/message/push', {
                to: target,
                messages: [{ type: 'text', text: part }],
            });
        }
        return last;
    }

    /**
     * 發送圖片（originalUrl 需為公網 https，如圖床連結；LINE 伺服器自行抓取）
     */
    async sendImage(target, originalUrl) {
        if (!this._enabled) {
            throw new Error('Handler not enabled');
        }
        return this._api('POST', '/message/push', {
            to: target,
            messages: [{
                type: 'image',
                originalContentUrl: originalUrl,
                previewImageUrl: originalUrl,
            }],
        });
    }

    /**
     * LINE 平台無法獲知自己發出的訊息 ID（push 無回執），
     * 因此不支援發送到 LINE 的跨平台回復引用與文件形式。
     */
    async deleteMessage() { /* LINE 無刪除訊息 API */ }

    start() {
        if (!this._started) {
            this._started = true;
            // 容忍啟動前 1 分鐘的舊事件
            this._startTime = Date.now() - 60000;
            this._server.listen(this._port, this._host, () => {
                winston.info(`LineBot webhook listening at ${this._host}:${this._port}${this._path}`);
                this.emit('ready');
            });
        }
    }

    stop() {
        if (this._started) {
            this._started = false;
            this._server.close();
        }
    }
}

module.exports = LineMessageHandler;
