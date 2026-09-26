/*
 * @name Matrix 訊息收發
 */

'use strict';

const format = require('string-format');
const winston = require('winston');

const htmlEscape = (str) => {
    return String(str).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
};

const truncate = (str, maxLen = 10) => {
    str = str.replace(/\n/gu, '');
    if (str.length > maxLen) {
        str = str.substring(0, maxLen - 3) + '...';
    }
    return str;
};

let bridge = null;
let config = null;
let matrixHandler = null;

let options = {};

const init = (b, h, c) => {
    bridge = b;
    config = c;
    matrixHandler = h;

    options = config.options.Matrix || {};

    // 將訊息加工好並發送給其他群組
    matrixHandler.on('text', (context) => {
        bridge.send(context).catch(e => winston.error(e.stack || e.message));
    });
};

// 收到了來自其他群組的訊息
const receive = async (msg) => {
    // 元信息，用于自定义样式
    let meta = {
        nick: msg.nick,
        from: msg.from,
        to: msg.to,
        text: msg.text,
        client_short: msg.extra.clientName.shortname,
        client_full: msg.extra.clientName.fullname,
        command: msg.command,
        param: msg.param
    };
    if (msg.extra.reply) {
        let reply = msg.extra.reply;
        meta.reply_nick = reply.nick;
        meta.reply_user = reply.username;
        if (reply.isText) {
            meta.reply_text = truncate(reply.message);
        } else {
            meta.reply_text = reply.message;
        }
    }
    if (msg.extra.forward) {
        meta.forward_nick = msg.extra.forward.nick;
        meta.forward_user = msg.extra.forward.username;
    }

    // 自定义消息样式
    let messageStyle = config.options.messageStyle;
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

    // 同時發送 HTML 格式（Element 等用戶端會優先顯示）
    let metaHTML = Object.assign({}, meta, {
        nick: `<strong>${htmlEscape(msg.nick)}</strong>`,
        text: htmlEscape(msg.text),
        reply_nick: htmlEscape(meta.reply_nick || ''),
        reply_text: htmlEscape(meta.reply_text || ''),
        forward_nick: htmlEscape(meta.forward_nick || ''),
    });
    let outputHTML = format(htmlEscape(template), metaHTML);

    // 影片/圖片/音訊上傳到 homeserver 以內嵌方式發送；其他類型以連結顯示
    let attachFileUrls = '';
    let pendingMedia = [];

    for (let upload of (msg.extra.uploads || [])) {
        if (upload.type === 'video') {
            pendingMedia.push({ type: 'm.video', url: upload.url, info: { mimetype: 'video/mp4' } });
        } else if (upload.type === 'image') {
            pendingMedia.push({ type: 'm.image', url: upload.url, info: { mimetype: 'image/png' } });
        } else if (upload.type === 'audio') {
            pendingMedia.push({ type: 'm.audio', url: upload.url, info: {} });
        } else {
            attachFileUrls += ` ${upload.url}`;
        }
    }

    let mainMessage = `${output}${attachFileUrls}`;
    if (mainMessage.trim() !== '') {
        await matrixHandler.sayWithHTML(msg.to, mainMessage, `${outputHTML}${attachFileUrls ? htmlEscape(attachFileUrls) : ''}`);
    }

    for (let media of pendingMedia) {
        try {
            await matrixHandler.sendMediaFromUrl(msg.to, media.url, media.type, media.info);
        } catch (e) {
            winston.warn(`MatrixBot failed to send media ${media.url}, falling back to URL: ${e.message}`);
            await matrixHandler.say(msg.to, media.url);
        }
    }
};

module.exports = {
    init,
    receive,
};
