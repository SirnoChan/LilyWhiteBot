/*
 * 跨平台回復/撤回測試（獨立進程，乾淨數據庫）
 * 運行：node --experimental-sqlite reply-test.js（Node <22.13 需 flag）
 */
'use strict';

const assert = require('assert');
const winston = require('winston');
winston.level = 'error';

const Context = require('./lib/handlers/Context.js');
const DiscordMessageHandler = require('./lib/handlers/DiscordMessageHandler.js');
const TelegramMessageHandler = require('./lib/handlers/TelegramMessageHandler.js');
const MatrixMessageHandler = require('./lib/handlers/MatrixMessageHandler.js');

const discordHandler = new DiscordMessageHandler({ bot: { token: 'fake' }, options: {} });
const telegramHandler = new TelegramMessageHandler({ bot: { token: '1:fake', name: 'test_bot' }, options: {} });
const matrixHandler = new MatrixMessageHandler({ bot: { homeserverUrl: 'https://e.invalid', accessToken: 'fake', userId: '@bot:e' }, options: {} });

const calls = { discord: [], telegram: [], matrix: [] };
let dSeq = 100, tSeq = 100, mSeq = 100;

discordHandler.say = async (target, message, options = {}) => {
    calls.discord.push({ target, message, options });
    return { id: `dm-${++dSeq}` };
};
discordHandler.deleteMessage = async (ref) => { calls.discord.push({ deleted: ref }); };

telegramHandler.say = async (target, message, options = {}) => {
    calls.telegram.push({ target, message, options });
    return { message_id: ++tSeq };
};
telegramHandler.sayWithHTML = async (target, message, options = {}) => {
    calls.telegram.push({ target, message, options });
    return { message_id: ++tSeq };
};
telegramHandler.deleteMessage = async (ref) => { calls.telegram.push({ deleted: ref }); };

matrixHandler.say = async (target, message, options = {}) => {
    calls.matrix.push({ target, message, options });
    return `$m-${++mSeq}`;
};
matrixHandler.sayWithHTML = async (target, message, formattedBody, options = {}) => {
    calls.matrix.push({ target, message, formattedBody, options });
    return `$m-${++mSeq}`;
};
matrixHandler.deleteMessage = async (ref) => { calls.matrix.push({ deleted: ref }); };

const pluginManager = {
    handlers: new Map([['Discord', discordHandler], ['Telegram', telegramHandler], ['Matrix', matrixHandler]]),
    global: { Context, Message: Context },
    plugins: {},
};

const transportOptions = {
    groups: [['discord/111', 'telegram/-222', 'matrix/!room:e']],
    options: {
        servemedia: { type: '' },
        messageStyle: {
            simple: {
                message: '[{nick}] {text}',
                reply: '[{nick}] Re {reply_nick} 「{reply_text}」: {text}',
                forward: '[{nick}] Fwd {forward_nick}: {text}',
                action: '* {nick} {text}',
                notice: '< {text} >',
            },
            complex: {
                message: '[{client_short} - {nick}] {text}',
                reply: '[{client_short} - {nick}] Re {reply_nick} 「{reply_text}」: {text}',
                forward: '[{client_short} - {nick}] Fwd {forward_nick}: {text}',
                action: '* {client_short} - {nick} {text}',
                notice: '< {client_full}: {text} >',
            },
        },
        Discord: {}, Matrix: {}, Telegram: {},
    },
};

const bridge = require('./plugins/transport.js')(pluginManager, transportOptions);

(async () => {
    // 步骤 1：三个平台各发一条消息（建立映射）
    const send = (handler, from, to, nick, text, nativeId, extra) => {
        const ctx = new Context({ from, to, nick, text, isPrivate: false, extra: extra || {}, handler, _rawdata: {} });
        ctx._nativeId = nativeId;
        return bridge.send(ctx);
    };

    await send(discordHandler, 'du1', '111', 'DiscordUser', 'hello from discord', 'd-src-1');
    await send(telegramHandler, 'tu1', '-222', 'TgUser', 'hello from telegram', 't-src-1');
    await send(matrixHandler, 'mu1', '!room:e', 'MatrixUser', 'hello from matrix', 'm-src-1');

    const entry = bridge.lookupSent('Discord', 'd-src-1');
    assert.ok(entry, 'discord source mapped');
    const tgFwd = entry.sent.get('Telegram')[0].id;
    const mxFwd = entry.sent.get('Matrix')[0].id;
    const tgEntry = bridge.lookupSent('Telegram', 't-src-1');
    assert.ok(tgEntry, 'telegram source mapped');

    // 步骤 2a：Telegram 用户回复 bot 转发的 Discord 消息 → Discord(源平台) 引用用户原消息；Matrix 引用 bot 转发
    calls.discord.length = 0; calls.matrix.length = 0;
    await send(telegramHandler, 'tu2', '-222', 'TgUser2', 're: hello', 't-src-2',
        { reply: { nick: 'DiscordUser', message: 'hello from discord', isText: true, _id: tgFwd, _isBot: true } });

    let mx = calls.matrix.find(c => c.options && c.options.replyTo);
    console.log('DBG2a expected replyTo:', JSON.stringify(mxFwd));
    assert.ok(mx && mx.options.replyTo === mxFwd, 'matrix references bot forward of discord msg');
    let dc = calls.discord.find(c => c.options && c.options.reference);
    assert.ok(dc && dc.options.reference === 'd-src-1', 'discord (source) references user original message');

    // 步骤 2b：平台内回复——Discord 用户 B 回复用户 A 的消息 → Telegram/Matrix 引用 bot 转发
    calls.matrix.length = 0; calls.telegram.length = 0; calls.discord.length = 0;
    await send(discordHandler, 'du2', '111', 'DiscordUserB', 'replying to A', 'd-src-2',
        { reply: { nick: 'DiscordUser', message: 'hello from discord', isText: true, _id: 'd-src-1', _isBot: false } });

    mx = calls.matrix.find(c => c.options && c.options.replyTo);
    assert.ok(mx && mx.options.replyTo === mxFwd, 'intra-platform reply: matrix references forward');
    let tg = calls.telegram.find(c => c.options && c.options.reply_to_message_id !== undefined);
    assert.ok(tg && tg.options.reply_to_message_id === tgFwd, 'intra-platform reply: telegram references forward');

    // 步骤 3：同 chat 不同消息 id 不串扰（TG 的 message_id 按 chat 独立——另一群的同号消息）
    calls.matrix.length = 0;
    // 伪造另一群的同号 bot 消息（模拟消息映射被另一群记录污染的场景）
    bridge.rememberSent('Discord', 'other-chat-src', 'other-chat', 'Telegram', [{ chat: 'other-chat', id: tgFwd }]);
    await send(telegramHandler, 'tu3', '-222', 'TgUser3', 'reply with ambiguous id', 't-src-3',
        { reply: { nick: 'DiscordUser', message: 'hello', isText: true, _id: tgFwd, _isBot: true } });

    mx = calls.matrix.find(c => c.options && c.options.replyTo);
    assert.ok(mx && mx.options.replyTo === mxFwd, 'chat-scoped lookup resolves the correct source despite id collision');

    // 步骤 4：跨平台撤回——Discord 用户删除自己的源消息 → Telegram/Matrix 的 bot 转发被删除
    calls.matrix.length = 0; calls.telegram.length = 0; calls.discord.length = 0;
    discordHandler.emit('recall', { nativeId: 'd-src-1' });
    await new Promise(r => setTimeout(r, 100));

    assert.ok(calls.telegram.some(c => c.deleted && c.deleted.id === tgFwd), 'telegram forward deleted');
    assert.ok(calls.matrix.some(c => c.deleted && c.deleted.id === mxFwd), 'matrix forward deleted');

    console.log('ALL REPLY/RECALL TESTS PASSED');
    process.exit(0);
})().catch(e => {
    console.error('FAILED:', e);
    process.exit(1);
});
