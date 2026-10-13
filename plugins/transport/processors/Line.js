/*
 * @name Line 訊息收發
 */

'use strict';

const format = require('string-format');
const winston = require('winston');

let bridge = null;
let config = null;
let lineHandler = null;

const init = (b, h, c) => {
    bridge = b;
    config = c;
    lineHandler = h;

    // 將訊息加工好並發送給其他群組
    lineHandler.on('text', (context) => {
        bridge.send(context).catch(e => winston.error(e.stack || e.message));
    });
};

// 收到了來自其他群組的訊息
const receive = async (msg) => {
    const meta = {
        nick: msg.nick,
        from: msg.from,
        to: msg.to,
        text: msg.text,
        client_short: msg.extra.clientName.shortname,
        client_full: msg.extra.clientName.fullname,
        command: msg.command,
        param: msg.param,
    };
    if (msg.extra.reply) {
        meta.reply_nick = msg.extra.reply.nick;
        meta.reply_user = msg.extra.reply.username;
        meta.reply_text = msg.extra.reply.isText ? msg.extra.reply.message.slice(0, 20) : msg.extra.reply.message;
    }

    const messageStyle = config.options.messageStyle;
    let styleMode = 'simple';
    if (msg.extra.clients >= 3 && (msg.extra.clientName.shortname || msg.isNotice)) {
        styleMode = 'complex';
    }

    let template;
    if (msg.isNotice) {
        template = messageStyle[styleMode].notice;
    } else if (msg.extra.isAction) {
        template = messageStyle[styleMode].action;
    } else if (msg.extra.reply) {
        template = messageStyle[styleMode].reply;
    } else if (msg.extra.forward) {
        template = messageStyle[styleMode].forward;
    } else {
        template = messageStyle[styleMode].message;
    }

    let output = format(template, meta);

    // LINE：圖片以 image 訊息發送（URL 由 LINE 伺服器抓取，需公網 https）；
    // 影片/音訊/文件 LINE Messaging API 不支援，以連結文字發送
    let attachUrls = '';
    let pendingImage = null;
    for (const upload of (msg.extra.uploads || [])) {
        if (upload.type === 'image' && !pendingImage) {
            pendingImage = upload.url;
        } else {
            attachUrls += ` ${upload.url}`;
        }
    }

    await lineHandler.say(msg.to, `${output}${attachUrls}`);

    if (pendingImage) {
        try {
            await lineHandler.sendImage(msg.to, pendingImage);
        } catch (e) {
            winston.warn(`LineBot failed to send image, falling back to URL: ${e.message}`);
            await lineHandler.say(msg.to, pendingImage);
        }
    }
};

module.exports = {
    init,
    receive,
};
