'use strict';

const path = require('path');
const BridgeMsg = require('../BridgeMsg.js');
const format = require('string-format');
const winston = require('winston');

const htmlEscape = (str) => {
    return str.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
};

let bridge = null;
let config = null;
let tgHandler = null;
let forwardBots = {};

let options = {};

// 如果是互聯機器人，那麼提取真實的使用者名稱和訊息內容
const parseForwardBot = (username, text) => {
    let realText, realNick;
    let symbol = forwardBots[username];
    if (symbol === 'self') {
        // TODO 更換匹配方式
        // [, , realNick, realText] = text.match(/^(|<.> )\[(.*?)\] ([^]*)$/mu) || [];
        [, realNick, realText] = text.match(/^\[(.*?)\] ([^]*)$/mu) || [];
    } else if (symbol === '[]') {
        [, realNick, realText] = text.match(/^\[(.*?)\](?::? |\n)([^]*)$/mu) || [];
    } else if (symbol === '<>') {
        [, realNick, realText] = text.match(/^<(.*?)>(?::? |\n)([^]*)$/mu) || [];
    }

    return { realNick, realText };
};

const init = (b, h, c) => {
    bridge = b;
    config = c;
    tgHandler = h;

    const options = config.options.Telegram || {};
    forwardBots = options.forwardBots || {};

    if (!options.notify) {
        options.notify = {};
    }

    // 我們自己也是傳話機器人
    forwardBots[tgHandler.username] = 'self';

    // 將訊息加工好並發送給其他群組
    tgHandler.on('text', (context) => {
        let extra = context.extra;
        if (context.text.match(/^\/([A-Za-z0-9_@]+)(\s+(.*)|\s*)$/u) && !options.forwardCommands) {
            return;
        }

        // 檢查是不是自己在回覆自己，然後檢查是不是其他互聯機器人在說話
        if (extra.reply && forwardBots[extra.reply.username]) {
            let { realNick, realText } = parseForwardBot(extra.reply.username, extra.reply.message);
            if (realNick) {
                [extra.reply.nick, extra.reply.message] = [realNick, realText];
            }
        } else if (extra.forward && forwardBots[extra.forward.username]) {
            let { realNick, realText } = parseForwardBot(extra.forward.username, context.text);
            if (realNick) {
                [extra.forward.nick, context.text] = [realNick, realText];
            }
        }

        bridge.send(context).catch(e => winston.error(e.stack));
    });

    tgHandler.on('richmessage', (context) => {
        let extra = context.extra;

        // 檢查是不是在回覆互聯機器人
        if (extra.reply && forwardBots[extra.reply.username]) {
            let { realNick, realText } = parseForwardBot(extra.reply.username, extra.reply.message);
            if (realNick) {
                [extra.reply.nick, extra.reply.message] = [realNick, realText];
            }
        }

        bridge.send(context).catch(e => winston.error(e.stack));
    });

    // Pinned message
    tgHandler.on('pin', (info, ctx) => {
        if (options.notify.pin) {
            bridge.send(new BridgeMsg({
                from: info.from.id,
                to: info.to,
                nick: info.from.nick,
                text: `${info.from.nick} pinned: ${info.text.replace(/\n/gu, ' ')}`,
                isNotice: true,
                handler: tgHandler,
                _rawdata: ctx,
            })).catch(e => winston.error(e.stack));
        }
    });


    /*
     * 加入與離開
     */
    tgHandler.on('join', (group, from, target, ctx) => {
        let text;
        if (from.id === target.id) {
            text = `${target.nick} 加入群組`;
        } else {
            text = `${from.nick} 邀請 ${target.nick} 加入群組`;
        }

        if (options.notify.join) {
            bridge.send(new BridgeMsg({
                from: target.id,
                to: group,
                nick: target.nick,
                text: text,
                isNotice: true,
                handler: tgHandler,
                _rawdata: ctx,
            })).catch(e => winston.error(e.stack));
        }
    });

    tgHandler.on('leave', (group, from, target, ctx) => {
        let text;
        if (from.id === target.id) {
            text = `${target.nick} 離開群組`;
        } else {
            text = `${target.nick} 被 ${from.nick} 移出群組`;
        }

        if (options.notify.leave) {
            bridge.send(new BridgeMsg({
                from: target.id,
                to: group,
                nick: target.nick,
                text: text,
                isNotice: true,
                handler: tgHandler,
                _rawdata: ctx,
            })).catch(e => winston.error(e.stack));
        }
    });
};

// 收到了來自其他群組的訊息
const receive = async (msg) => {
    // 元信息，用于自定义样式
    let meta = {
        nick: `<b>${htmlEscape(msg.nick)}</b>`,
        from: htmlEscape(msg.from),
        to: htmlEscape(msg.to),
        text: htmlEscape(msg.text),
        client_short: htmlEscape(msg.extra.clientName.shortname),
        client_full: htmlEscape(msg.extra.clientName.fullname),
        command: htmlEscape(msg.command),
        param: htmlEscape(msg.param)
    };
    
    // 自定义消息样式
    let styleMode = 'simple';
    let messageStyle = config.options.messageStyle;
    if (/*msg.extra.clients >= 3 && */(msg.extra.clientName.shortname || msg.isNotice)) {
        styleMode = 'complex';
    }

    let template;
    if (msg.isNotice) {
        template = messageStyle[styleMode].notice;
    } else if (msg.extra.isAction) {
        template = messageStyle[styleMode].action;
    } else {
        template = messageStyle[styleMode].message;
    }

    template = htmlEscape(template);
    let output = format(template, meta);
    let newRawMsg = await tgHandler.sayWithHTML(msg.to, output);

    // 如果含有相片和音訊
    if (msg.extra.uploads) {
        let replyOption = {
            reply_to_message_id: newRawMsg.message_id
        };

        for (let upload of msg.extra.uploads) {
            if (upload.type === 'audio') {
                try {
                    await tgHandler.sendAudio(msg.to, upload.url, replyOption);
                } catch (e) {
                    // Telegram 以 URL 抓取檔案限 20MB，超限或抓取失敗時以連結兜底
                    winston.warn(`TelegramBot failed to send audio, falling back to URL: ${e.message}`);
                    await tgHandler.say(msg.to, upload.url);
                }
            } else if (upload.type === 'image') {
                if (path.extname(upload.url) === '.gif') {
                    await tgHandler.sendAnimation(msg.to, upload.url, replyOption);
                } else {
                    await tgHandler.sendPhoto(msg.to, upload.url, replyOption);
                }
            } else if (upload.type === 'video') {
                // 以影片形式傳送（Telegram 伺服器自行從 URL 抓取），用戶端內嵌播放
                try {
                    await tgHandler.sendVideo(msg.to, upload.url, replyOption);
                } catch (e) {
                    try {
                        await tgHandler.sendDocument(msg.to, upload.url, replyOption);
                    } catch (e2) {
                        winston.warn(`TelegramBot failed to send video as both video and document, falling back to URL: ${e2.message}`);
                        await tgHandler.say(msg.to, upload.url);
                    }
                }
            } else {
                try {
                    await tgHandler.sendDocument(msg.to, upload.url, replyOption);
                } catch (e) {
                    winston.warn(`TelegramBot failed to send document, falling back to URL: ${e.message}`);
                    await tgHandler.say(msg.to, upload.url);
                }
            }
        }
    }
};

module.exports = {
    init,
    receive,
};
