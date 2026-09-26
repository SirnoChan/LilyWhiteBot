/*
 * @name 使用通用介面處理 Discord 訊息
 *
 * 使用 discord.js v14。相比舊版（v12）：
 * 1. 必須顯式宣告 Gateway Intents（含 Message Content 特權 Intent）；
 * 2. 能正確處理頻道串（Thread）、語音頻道文字等新頻道類型，不再因
 *    MESSAGE_UPDATE 內部解析失敗而拋出未捕獲異常（舊版掉線的主要成因）；
 * 3. 增加 shardDisconnect 後的自動重新登入兜底（指數退避），
 *    覆蓋 discord.js 放棄自動重連的場景（如 1000/4005 等）。
 */

const MessageHandler = require('./MessageHandler.js');
const Context = require('./Context.js');
const discord = require('discord.js');
const winston = require('winston');
const path = require('path');
const { getFriendlySize } = require('../util.js');
const ext = require('ext-list')();

// discord.js 不再自動重連，且重試也無濟於事的關閉碼
const NO_RETRY_CLOSE_CODES = [4004, 4010, 4011, 4012, 4013, 4014];

class DiscordMessageHandler extends MessageHandler {
    constructor (config = {}) {
        super();

        let botConfig = config.bot || {};
        let discordOptions = config.options || {};

        // v14 必須顯式宣告 Intents；GuildMembers 為特權 Intent，僅在配置明確開啟時使用
        let intents = [
            discord.GatewayIntentBits.Guilds,
            discord.GatewayIntentBits.GuildMessages,
            discord.GatewayIntentBits.MessageContent,
            discord.GatewayIntentBits.DirectMessages,
        ];
        if (discordOptions.guildMembersIntent) {
            intents.push(discord.GatewayIntentBits.GuildMembers);
        }

        let clientOptions = { intents };
        if (discordOptions.apiRoot !== undefined) clientOptions.rest = Object.assign({}, clientOptions.rest, { api: discordOptions.apiRoot });
        if (discordOptions.cdnRoot !== undefined) clientOptions.rest = Object.assign({}, clientOptions.rest, { cdn: discordOptions.cdnRoot });

        const client = new discord.Client(clientOptions);

        client.on(discord.Events.ClientReady, (client) => {
            winston.info(`DiscordBot is ready. (logged in as ${client.user.tag})`);
            this.emit('ready', client);
            this._resetReconnectAttempts();
        });

        client.on(discord.Events.Error, (message) => {
            winston.error(`DiscordBot Error: ${message.message}`);
        });

        client.on(discord.Events.ShardError, (error, shardId) => {
            winston.error(`DiscordBot shard #${shardId} error: ${error.message}`);
        });

        client.on(discord.Events.ShardReconnecting, (shardId) => {
            winston.info(`DiscordBot shard #${shardId} connection lost, reconnecting...`);
        });

        client.on(discord.Events.ShardResume, (shardId, replayedEvents) => {
            winston.info(`DiscordBot shard #${shardId} resumed. (${replayedEvents} events replayed)`);
            this._resetReconnectAttempts();
        });

        // discord.js 放棄自動重連時（shardDisconnect 事件）的兜底：手動重新登入
        client.on(discord.Events.ShardDisconnect, (event, shardId) => {
            winston.warn(`DiscordBot shard #${shardId} disconnected: code ${event.code} (${event.reason || 'no reason'}).`);

            if (this._started && !this._reloginScheduled) {
                if (NO_RETRY_CLOSE_CODES.includes(event.code)) {
                    // 4004 Token 無效、4010+ 為協議/配置錯誤，重試沒有意義
                    winston.error(`DiscordBot will NOT reconnect automatically: close code ${event.code}. Please check the bot token / privileged intents settings.`);
                } else {
                    this._reloginScheduled = true;
                    this._scheduleRelogin();
                }
            }
        });

        this._type = 'Discord';
        this._id = 'D';

        this._token = botConfig.token;
        this._client = client;
        this._nickStyle = discordOptions.nickStyle || 'username';
        this._keepSilence = discordOptions.keepSilence || [];
        this._useProxyURL = discordOptions.useProxyURL;
        this._relayEmoji = discordOptions.relayEmoji;
        this._maxMessageLength = discordOptions.maxMessageLength || 2000;

        this._reloginScheduled = false;
        this._reconnectAttempts = 0;

        const processMessage = async (rawdata) => {
            if (!this._enabled || !rawdata.author || !client.user || rawdata.author.id === client.user.id) {
                return;
            }

            let text = rawdata.content;
            let extra = {};
            if (rawdata.attachments && rawdata.attachments.size) {
                extra.files = []
                for (let [, p] of rawdata.attachments) {
                    let mimetype = p.contentType || (ext.get((path.extname(p.name) || '').slice(1)) || 'unknown');
                    let type = mimetype.split('/')[0];
                    extra.files.push({
                        client: 'Discord',
                        type: type,
                        id: p.id,
                        size: p.size,
                        url: this._useProxyURL ? p.proxyURL : p.url,
                    });
                    switch (type) {
                      case 'audio':
                        text += ` <Audio: ${getFriendlySize(p.size)}>`;
                        break;
                      case 'image':
                        text += ` <Image: ${p.width}x${p.height}, ${getFriendlySize(p.size)}>`;
                        break;
                      case 'video':
                        text += ` <Video: ${p.width}x${p.height}, ${getFriendlySize(p.size)}>`;
                        break;
                      default:
                        text += ` <Attachment: ${getFriendlySize(p.size)}>`;
                        break;
                    }
                }
            }

            if (rawdata.reference && rawdata.reference.messageId) {
                if (rawdata.channel.id == rawdata.reference.channelId) {
                    try {
                        let msg = await rawdata.channel.messages.fetch(rawdata.reference.messageId);
                        let reply = {
                            nick: this.getNick(msg.member||msg.author),
                            username: msg.author.username,
                            discriminator: msg.author.discriminator,
                            message: this._convertToText(msg),
                            isText: msg.content && true,
                            _rawdata: msg,
                        };

                        extra.reply = reply;
                    } catch (e) {
                        // Discord API 找不到被回覆的訊息或其他錯誤
                        winston.warn(`Error on processing discord reply: ${e.message}`);
                    }

                }
            }

            let context = new Context({
                from: rawdata.author.id,
                to: rawdata.channel.id,
                nick: this.getNick(rawdata.member||rawdata.author),
                text: text,
                isPrivate: rawdata.channel.type === discord.ChannelType.DM,
                extra: extra,
                handler: this,
                _rawdata: rawdata,
            });

            // 檢查是不是命令
            for (let [cmd, callback] of this._commands) {
                if (rawdata.content.startsWith(cmd)) {
                    let param = rawdata.content.trim().substring(cmd.length);
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
        };

        client.on(discord.Events.MessageCreate, processMessage);
    }

    _resetReconnectAttempts() {
        this._reconnectAttempts = 0;
    }

    _scheduleRelogin() {
        // 指數退避：30s 起，最長 30 分鐘
        let delay = Math.min(30000 * Math.pow(2, this._reconnectAttempts), 1800000);
        this._reconnectAttempts++;

        winston.info(`DiscordBot trying to re-login in ${Math.round(delay / 1000)} seconds... (attempt ${this._reconnectAttempts})`);

        setTimeout(async () => {
            this._reloginScheduled = false;
            if (!this._started) {
                return;
            }

            try {
                this._client.destroy();
            } catch (e) {
                winston.warn(`DiscordBot destroy error while reconnecting: ${e.message}`);
            }

            try {
                await this._client.login(this._token);
            } catch (e) {
                winston.error(`DiscordBot re-login failed: ${e.message}`);
                if (this._started) {
                    this._reloginScheduled = true;
                    this._scheduleRelogin();
                }
            }
        }, delay);
    }

    splitText(text, maxLength = 2000) {
        let lines = String(text).replace(/\r\n/gu, '\n').split('\n');
        let messages = [];
        let current = '';

        for (let line of lines) {
            // 過長的單行按字元切開
            while (line.length > maxLength) {
                if (current !== '') {
                    messages.push(current);
                    current = '';
                }
                messages.push(line.slice(0, maxLength));
                line = line.slice(maxLength);
            }

            if (current === '') {
                current = line;
            } else if (`${current}\n${line}`.length <= maxLength) {
                current += `\n${line}`;
            } else {
                messages.push(current);
                current = line;
            }
        }
        if (current !== '' || messages.length === 0) {
            messages.push(current);
        }

        return messages;
    }

    async say(target, message, options = {}) {
        if (!this._enabled) {
            throw new Error('Handler not enabled');
        } else if (this._keepSilence.indexOf(target) !== -1) {
            return;
        } else {
            let channel = await this._client.channels.fetch(target);

            if (options.files && options.files.length) {
                // 附件（如影片）隨訊息一起發送，Discord 會直接內嵌播放
                let messages = this.splitText(message, this._maxMessageLength);
                let last = messages.pop();
                for (let m of messages) {
                    await channel.send(m);
                }
                return await channel.send({ content: last, files: options.files });
            } else {
                let messages = this.splitText(message, this._maxMessageLength);
                let sent = null;
                for (let m of messages) {
                    sent = await channel.send(m);
                }
                return sent;
            }
        }
    }

    async reply(context, message, options = {}) {
        if (context.isPrivate) {
            return await this.say(context.from, message, options);
        } else {
            if (options.noPrefix) {
                return await this.say(context.to, `${message}`, options);
            } else {
                return await this.say(context.to, `${context.nick}: ${message}`, options);
            }
        }
    }

    getNick(userobj) {
        if (userobj) {
            if (userobj instanceof discord.GuildMember) {
              var { nickname, id, user } = userobj;
              var { username } = user;
            } else {
              var { username, id } = userobj;
              var nickname = null;
            }

            if (this._nickStyle === 'nickname') {
                return nickname || username || id;
            } else if (this._nickStyle === 'username') {
                return username || id;
            } else {
                return id;
            }
        } else {
            return '';
        }
    }

    async fetchUser(user) {
        return await this._client.users.fetch(user);
    }

    fetchEmoji(emoji) {
        return this._client.emojis.resolve(emoji);
    }

    _convertToText(message) {
        if (message.content) {
            return message.content;
        } else if (message.attachments && message.attachments.size) {
            let p = message.attachments.first();
            let mimetype = p.contentType || (ext.get((path.extname(p.name) || '').slice(1)) || 'unknown');
            switch (mimetype.split('/')[0]) {
              case 'audio': return '<Audio>';
              case 'image': return '<Image>';
              case 'video': return '<Video>';
              default: return '<Attachment>';
            }
        } else {
            return '<Message>';
        }
    }

    async start() {
        if (!this._started) {
            this._started = true;
            this._resetReconnectAttempts();
            try {
                await this._client.login(this._token);
            } catch (e) {
                winston.error(`DiscordBot login failed: ${e.message}`);
            }
        }
    }

    async stop() {
        if (this._started) {
            this._started = false;
            this._client.destroy();
        }
    }
}

module.exports = DiscordMessageHandler;
