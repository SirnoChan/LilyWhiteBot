/*
 * LINE 插件测试（离线）：webhook 签名验证 + 事件处理 + push
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const winston = require('winston');
winston.level = 'error';

const Context = require('./lib/handlers/Context.js');
const LineMessageHandler = require('./lib/handlers/LineMessageHandler.js');

const SECRET = 'testsecret';
const TOKEN = 'testtoken';
const PORT = 11999;

const lineHandler = new LineMessageHandler({
    bot: {
        channelAccessToken: TOKEN,
        channelSecret: SECRET,
        listen: { host: '127.0.0.1', port: PORT, path: '/line-webhook' },
    },
    options: {},
});

const calls = { say: [], sendImage: [] };
lineHandler.say = async (target, message, options = {}) => {
    calls.say.push({ target, message, options });
    return {};
};
lineHandler.sendImage = async (target, url) => {
    calls.sendImage.push({ target, url });
    return {};
};

let received = null;
lineHandler.on('text', (ctx) => { received = ctx; });

lineHandler.start();

const post = (body, sign) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
        host: '127.0.0.1', port: PORT, path: '/line-webhook', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Line-Signature': sign || crypto.createHmac('SHA256', SECRET).update(data).digest('base64') },
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.end(data);
});

(async () => {
    await new Promise(r => setTimeout(r, 300));

    // 1. 错误签名被拒绝
    await post({ events: [] }, 'badsignature');
    assert.ok(calls.say.length === 0 && !received, 'bad signature rejected');

    // 2. 正确签名：群组文本消息
    const ev1 = {
        type: 'message', webhookEventId: 'evt1', timestamp: Date.now(),
        source: { type: 'group', groupId: 'C123', userId: 'U1' },
        message: { type: 'text', id: 'm1', text: 'hello from LINE' },
    };
    await post({ events: [ev1] });
    await new Promise(r => setTimeout(r, 500));
    assert.ok(received, 'text event emitted');
    assert.strictEqual(received.text, 'hello from LINE');
    assert.strictEqual(received.to, 'C123');
    assert.strictEqual(received.from, 'U1');

    // 3. 同一事件重发被去重
    received = null;
    await post({ events: [ev1] });
    await new Promise(r => setTimeout(r, 500));
    assert.strictEqual(received, null, 'duplicate event deduped');

    // 4. push 发送
    await lineHandler.say('C123', 'reply text');
    assert.strictEqual(calls.say[0].target, 'C123');
    assert.strictEqual(calls.say[0].message, 'reply text');
    console.log('ALL LINE TESTS PASSED');
    lineHandler.stop();
    process.exit(0);
})().catch(e => { console.error('FAILED:', e); lineHandler.stop(); process.exit(1); });
