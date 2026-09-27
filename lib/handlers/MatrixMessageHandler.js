/*
 * @name 使用通用介面處理 Matrix 訊息
 *
 * 基於 matrix-bot-sdk（https://github.com/matrix-org/matrix-bot-sdk）。
 *
 * 限制：
 * 1. 需要已有 Matrix 帳號的 Access Token（參見 config.example.yml 的說明）；
 * 2. 不支援端到端加密（E2EE）房間——加密房間內的訊息無法解讀，會被忽略。
 */

const MessageHandler = require('./MessageHandler.js');
const Context = require('./Context.js');
const { MatrixClient } = require('matrix-bot-sdk');
const { LRUCache } = require('lru-cache');
const winston = require('winston');
const { getFriendlySize } = require('../util.js');

// 各 msgtype 轉成統一的檔案類型
const FILE_TYPES = {
    'm.image': 'image',
    'm.video': 'video',
    'm.audio': 'audio',
    'm.file': 'file',
};

class MatrixMessageHandler extends MessageHandler {
    constructor (config = {}) {
        super();

        let botConfig = config.bot || {};
        let mxOptions = config.options || {};

        if (!botConfig.homeserverUrl || !botConfig.accessToken) {
            throw new Error('Matrix bot config error: homeserverUrl and accessToken are required.');
        }

        const client = new MatrixClient(botConfig.homeserverUrl, botConfig.accessToken);

        this._type = 'Matrix';
        this._id = 'M';

        this._client = client;
        this._homeserverUrl = botConfig.homeserverUrl.replace(/\/+$/u, '');
        this._accessToken = botConfig.accessToken;
        this._userId = botConfig.userId || null;
        this._nickStyle = mxOptions.nickStyle || 'displayname';
        this._keepSilence = mxOptions.keepSilence || [];
        this._autoJoin = mxOptions.autoJoin || false;
        this._startTime = 0;

        // userId -> displayname 緩存
        this._displayNames = new LRUCache({ max: 500, ttl: 3600000 });

        if (this._autoJoin) {
            client.on('room.invite', (roomId) => {
                client.joinRoom(roomId)
                    .then(() => winston.info(`MatrixBot has joined room: ${roomId}`))
                    .catch(e => winston.error(`MatrixBot failed to join room ${roomId}: ${e.message}`));
            });
        }

        client.on('room.message', (roomId, event) => {
            winston.debug(`[Matrix] room.message event: ${event && event.event_id} from ${event && event.sender} in ${roomId} (msgtype: ${event && event.content && event.content.msgtype})`);
            this._processMessage(roomId, event).catch(e => winston.error(`MatrixBot error on processing message: ${e.stack || e.message}`));
        });
    }

    /**
     * 把 mxc:// URI 轉成可下載的 HTTP URL。
     * matrix.org 等伺服器已啟用鑑權媒體（MSC3916），匿名存取 media 端點會 404，
     * 故使用 v1 鑑權端點並附上 access_token（該 URL 僅供程式內部下載媒體用）。
     */
    _mxcToHttp(mxc) {
        let m = String(mxc).match(/^mxc:\/\/([^/]+)\/(.+)$/u);
        if (!m) {
            return this._client.mxcToHttp(mxc);
        }
        return `${this._homeserverUrl}/_matrix/client/v1/media/download/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}?access_token=${encodeURIComponent(this._accessToken)}`;
    }

    async _resolveNick(userId) {
        if (this._nickStyle === 'mxid' || !userId) {
            return userId || '';
        }

        if (this._displayNames.has(userId)) {
            return this._displayNames.get(userId) || userId;
        }

        try {
            // 跨域（聯邦）查詢暱稱可能很慢，加超時保護，超時則退回 mxid
            let profile = await Promise.race([
                this._client.getUserProfile(userId),
                new Promise(resolve => setTimeout(() => resolve(null), 5000)),
            ]);
            let name = (profile && profile.displayname) || userId;
            this._displayNames.set(userId, name);
            return name;
        } catch (e) {
            // 無法取得暱稱時退回 mxid
            return userId;
        }
    }

    async _processMessage(roomId, event) {
        if (!this._enabled || !event || !event.content) {
            return;
        }

        // 忽略自己（和其他機器人的重複同步）
        if (event.sender === this._userId) {
            return;
        }

        // 忽略啟動前的舊訊息（初始 sync 會帶最後一條訊息）
        if (this._startTime && event.origin_server_ts && event.origin_server_ts < this._startTime) {
            return;
        }

        const content = event.content;
        const msgtype = content.msgtype;

        // 訊息編輯（m.replace）會以新事件形式重複出現，這裏忽略之
        let relatesTo = content['m.relates_to'];
        if (relatesTo && relatesTo.rel_type === 'm.replace') {
            return;
        }

        let text = content.body || '';
        let extra = {};

        // 媒體（加密房間的媒體沒有 url 欄位，暫不支援）
        if (FILE_TYPES[msgtype] && content.url && String(content.url).startsWith('mxc://')) {
            let info = content.info || {};
            let type = FILE_TYPES[msgtype];
            text = `<${msgtype === 'm.file' ? 'File' : msgtype.substr(2, 1).toUpperCase() + msgtype.substr(3)}: ${getFriendlySize(info.size || 0)}>`;
            if (msgtype === 'm.video' || msgtype === 'm.image') {
                text = `<${msgtype.substr(2, 1).toUpperCase() + msgtype.substr(3)}: ${info.w || '?'}x${info.h || '?'}, ${getFriendlySize(info.size || 0)}>`;
            }

            extra.files = [{
                client: 'Matrix',
                type: type,
                id: event.event_id,
                size: info.size,
                url: this._mxcToHttp(content.url),
            }];
        }

        // 回覆
        if (relatesTo && relatesTo['m.in_reply_to'] && relatesTo['m.in_reply_to'].event_id) {
            try {
                let ev = await this._client.getEvent(roomId, relatesTo['m.in_reply_to'].event_id);
                if (ev && ev.content) {
                    let replyText = ev.content.body || '<Message>';
                    // Matrix 回覆的 body 自帶引用前綴（> <@user> ...），去除之
                    replyText = replyText.split('\n').filter(l => !l.startsWith('> ')).join('\n').trim() || '<Message>';

                    extra.reply = {
                        nick: await this._resolveNick(ev.sender),
                        username: ev.sender,
                        message: replyText,
                        isText: !FILE_TYPES[ev.content.msgtype],
                        _rawdata: ev,
                    };
                }
            } catch (e) {
                winston.warn(`Error on processing matrix reply: ${e.message}`);
            }
        }

        let nick = await this._resolveNick(event.sender);

        let context = new Context({
            from: event.sender,
            to: roomId,
            nick: nick,
            text: text,
            isPrivate: false,
            extra: extra,
            handler: this,
            _rawdata: event,
        });

        if (msgtype === 'm.emote') {
            context.extra.isAction = true;
        }

        // 檢查是不是命令（與 IRC/Discord 相同的前綴式命令）
        for (let [cmd, callback] of this._commands) {
            if (text.startsWith(cmd)) {
                let param = text.trim().substring(cmd.length);
                if (param === '' || param.startsWith(' ')) {
                    param = param.trim();

                    context.command = cmd;
                    context.param = param;

                    if (typeof callback === 'function') {
                        callback(context, cmd, param);
                    }

                    this.emit('command', context, cmd, param);
                    this.emit(`command#${cmd}`, context, param);
                }
            }
        }

        this.emit('text', context);
    }

    get userId() { return this._userId; }

    async say(target, message, options = {}) {
        if (!this._enabled) {
            throw new Error('Handler not enabled');
        } else if (this._keepSilence.indexOf(target) !== -1) {
            return;
        } else {
            let content;
            if (options.formatted_body) {
                content = {
                    msgtype: options.msgtype || 'm.text',
                    body: message,
                    format: 'org.matrix.custom.html',
                    formatted_body: options.formatted_body,
                };
            } else {
                content = {
                    msgtype: options.msgtype || 'm.text',
                    body: message,
                };
            }

            if (options.replyTo) {
                content['m.relates_to'] = {
                    'm.in_reply_to': {
                        event_id: options.replyTo,
                    },
                };
            }

            return await this._client.sendMessage(target, content);
        }
    }

    sayWithHTML(target, message, formattedBody, options = {}) {
        let options2 = Object.assign({}, options, { formatted_body: formattedBody });
        return this.say(target, message, options2);
    }

    /**
     * 從 URL 取得媒體並上傳到 homeserver，以指定 msgtype 發送。
     * 影片（m.video）、圖片（m.image）、音訊（m.audio）在用戶端中會內嵌顯示/播放。
     */
    async sendMediaFromUrl(target, url, type, info = {}, filename) {
        if (!this._enabled) {
            throw new Error('Handler not enabled');
        }

        let mxc = await this._client.uploadContentFromUrl(url);
        let content = {
            msgtype: type,
            url: mxc,
            body: filename || url,
            info: info || {},
        };
        return await this._client.sendMessage(target, content);
    }

    async reply(context, message, options = {}) {
        if (options.noPrefix) {
            return await this.say(context.to, `${message}`, options);
        } else {
            return await this.say(context.to, `${context.nick}: ${message}`, options);
        }
    }

    async start() {
        if (!this._started) {
            this._started = true;

            // 容忍 1 分鐘內的舊訊息
            this._startTime = Date.now() - 60000;

            if (!this._userId) {
                try {
                    this._userId = await this._client.getUserId();
                } catch (e) {
                    winston.error(`MatrixBot failed to get user ID: ${e.message}`);
                }
            }
            winston.info(`MatrixBot logged in as ${this._userId}.`);

            // 看門狗：每輪 /sync 都會經過 doSync；long-poll 正常最長約 40 秒一輪，
            // 若長時間無輪轉說明 sync 卡死（連接掛起等），自動重啟客戶端
            if (!this._syncWatchdog) {
                const client = this._client;
                const origDoSync = client.doSync.bind(client);
                this._lastSyncAt = Date.now();
                client.doSync = async (token) => {
                    const response = await origDoSync(token);
                    this._lastSyncAt = Date.now();
                    return response;
                };

                this._syncWatchdog = setInterval(() => {
                    if (Date.now() - this._lastSyncAt > 180000) {
                        winston.warn('MatrixBot sync stalled for over 3 minutes, restarting client...');
                        this._lastSyncAt = Date.now();
                        try { client.stop(); } catch (e) { /* 忽略 */ }
                        this._clientStart().catch(e => winston.error(`MatrixBot restart error: ${e.message}`));
                    }
                }, 60000);
                this._syncWatchdog.unref();
            }

            await this._clientStart();
        }
    }

    async _clientStart() {
        return this._client.start()
            .then(() => {
                winston.info('MatrixBot is ready.');
                this.emit('ready');
            })
            .catch(e => winston.error(`MatrixBot sync error: ${e.message}`));
    }

    async stop() {
        if (this._started) {
            this._started = false;
            this._client.stop();
        }
    }
}

module.exports = MatrixMessageHandler;
