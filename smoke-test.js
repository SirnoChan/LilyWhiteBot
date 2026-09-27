/*
 * 离线冒烟测试：不连接任何真实平台
 * 1. 构造 Discord/Matrix/Telegram handler（不 start）
 * 2. 加载 transport 插件，建立 discord <-> matrix <-> telegram 互联
 * 3. 模拟消息路由（含视频 uploads 的内嵌发送路径）
 * 运行：node smoke-test.js
 */
'use strict';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const assert = require('assert');
const fs = require('fs');
const winston = require('winston');
winston.level = 'error';

const Context = require('./lib/handlers/Context.js');
const BridgeMsg = require('./plugins/transport/BridgeMsg.js');

// ---------------------------------------------------------------- handlers
const DiscordMessageHandler = require('./lib/handlers/DiscordMessageHandler.js');
const discordHandler = new DiscordMessageHandler({ bot: { token: 'fake' }, options: {} });

const MatrixMessageHandler = require('./lib/handlers/MatrixMessageHandler.js');
const matrixHandler = new MatrixMessageHandler({
    bot: { homeserverUrl: 'https://example.invalid', accessToken: 'fake', userId: '@bot:example.invalid' },
    options: {},
});

const TelegramMessageHandler = require('./lib/handlers/TelegramMessageHandler.js');
const telegramHandler = new TelegramMessageHandler({ bot: { token: '1:fake', name: 'test_bot' }, options: {} });

assert.strictEqual(discordHandler.type, 'Discord');
assert.strictEqual(matrixHandler.type, 'Matrix');
assert.strictEqual(telegramHandler.type, 'Telegram');
assert.strictEqual(matrixHandler.userId, '@bot:example.invalid');
console.log('[1] handlers constructed OK');

// 拦截所有出站调用，记录而不发网络请求
const calls = { discord: [], matrix: [], telegram: [] };

discordHandler.say = async (target, message, options = {}) => {
    calls.discord.push({ target, message, options });
};
matrixHandler.say = async (target, message, options = {}) => {
    calls.matrix.push({ target, message, options });
};
matrixHandler.sayWithHTML = async (target, message, formattedBody, options = {}) => {
    calls.matrix.push({ target, message, formattedBody, options });
};
matrixHandler.sendMediaFromUrl = async (target, url, type, info = {}) => {
    calls.matrix.push({ target, media: { url, type, info } });
};
telegramHandler.say = async (target, message, options = {}) => {
    calls.telegram.push({ target, message, options });
    return { message_id: 1 };
};
telegramHandler.sayWithHTML = async (target, message, options = {}) => {
    calls.telegram.push({ target, message, options });
    return { message_id: 1 };
};
telegramHandler.sendVideo = async (target, video, options = {}) => {
    calls.telegram.push({ target, sendVideo: video, options });
};
telegramHandler.sendPhoto = async (target, photo, options = {}) => {
    calls.telegram.push({ target, sendPhoto: photo, options });
};
telegramHandler.sendDocument = async (target, doc, options = {}) => {
    calls.telegram.push({ target, sendDocument: doc, options });
};

// ---------------------------------------------------------------- transport
const pluginManager = {
    handlers: new Map([
        ['Discord', discordHandler],
        ['Matrix', matrixHandler],
        ['Telegram', telegramHandler],
    ]),
    global: { Context, Message: Context },
    plugins: {},
};

const transportOptions = {
    groups: [
        ['discord/111', 'matrix/!room:example.invalid', 'telegram/-222'],
    ],
    options: {
        servemedia: { type: '' },  // 不上传图床
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
        Discord: {},
        Matrix: {},
        Telegram: {},
    },
};

const bridge = require('./plugins/transport.js')(pluginManager, transportOptions);
console.log('[2] transport loaded, map keys:', Object.keys(bridge.map).join(' | '));

(async () => {
    // ------------------------------------------------ 普通文本：Discord -> Matrix/Telegram
    let ctx = new Context({
        from: 'user1',
        to: '111',
        nick: 'DiscordUser',
        text: 'hello world',
        isPrivate: false,
        extra: {},
        handler: discordHandler,
    });

    await bridge.send(ctx);

    assert.strictEqual(calls.matrix.length, 1, 'matrix should receive 1 message');
    assert.ok(calls.matrix[0].message.includes('DiscordUser'), 'matrix message contains nick');
    assert.ok(calls.matrix[0].formattedBody.includes('<strong>DiscordUser</strong>'), 'matrix HTML formatted');
    assert.strictEqual(calls.matrix[0].target, '!room:example.invalid');

    assert.strictEqual(calls.telegram.length, 1, 'telegram should receive 1 message');
    assert.ok(calls.telegram[0].message.includes('DiscordUser'));
    console.log('[3] text routing Discord -> Matrix/Telegram OK');

    // ------------------------------------------------ 视频：分别验证各平台的内嵌发送路径
    const MatrixProcessor = require('./plugins/transport/processors/Matrix.js');
    const DiscordProcessor = require('./plugins/transport/processors/Discord.js');
    const TelegramProcessor = require('./plugins/transport/processors/Telegram.js');

    let videoMsg = new BridgeMsg({
        from: '@user:example.invalid',
        to: '!room:example.invalid',
        nick: 'MatrixUser',
        text: 'check this video',
        isPrivate: false,
        extra: {
            clients: 3,
            clientName: { shortname: 'M', fullname: 'Matrix' },
            uploads: [
                { type: 'video', url: 'https://cdn.example.invalid/v.mp4' },
                { type: 'file', url: 'https://cdn.example.invalid/doc.pdf' },
            ],
        },
        handler: matrixHandler,
    });

    // Matrix 端：视频应通过 sendMediaFromUrl 以 m.video 发送
    await MatrixProcessor.receive(videoMsg);
    let mxMedia = calls.matrix.filter(c => c.media);
    assert.ok(mxMedia.length === 1, 'matrix should send 1 media');
    assert.strictEqual(mxMedia[0].media.type, 'm.video');
    assert.strictEqual(mxMedia[0].media.url, 'https://cdn.example.invalid/v.mp4');
    assert.ok(calls.matrix.some(c => c.message && c.message.includes('doc.pdf')), 'non-media url appended as text');
    console.log('[4] Matrix video sent as m.video (inline) OK');

    // Discord 端：视频应作为附件随消息发送
    await DiscordProcessor.receive(videoMsg);
    assert.strictEqual(calls.discord.length, 1, 'discord receive video msg');
    assert.ok(calls.discord[0].options && calls.discord[0].options.files, 'discord should get files option');
    assert.strictEqual(calls.discord[0].options.files[0].name, 'video.mp4', 'video attachment name');
    assert.ok(calls.discord[0].message.includes('doc.pdf'), 'non-video url appended as text');
    console.log('[5] Discord video sent as inline attachment OK');

    // Telegram 端：视频应通过 sendVideo 发送
    await TelegramProcessor.receive(videoMsg);
    let tgVideo = calls.telegram.filter(c => c.sendVideo);
    assert.ok(tgVideo.length === 1, 'telegram should send video via sendVideo');
    assert.strictEqual(tgVideo[0].sendVideo, 'https://cdn.example.invalid/v.mp4');
    console.log('[6] Telegram video sent via sendVideo (inline) OK');

    // ------------------------------------------------ file.js convertFileType
    const fileModule = require('./plugins/transport/file.js');
    // 不直接访问内部函数，验证行为：convertFileType 逻辑已内联在 uploadFile；
    // 通过构造 servemedia.type=source 的 hook 验证 video 类型保留
    let sourceOpts = JSON.parse(JSON.stringify(transportOptions));
    sourceOpts.options.servemedia = { type: 'source' };
    // 重新初始化 file 插件
    const bridge2 = require('./plugins/transport.js')(pluginManager, sourceOpts);
    calls.matrix.length = 0;
    calls.telegram.length = 0;
    calls.discord.length = 0;

    let videoCtx = new Context({
        from: 'user1',
        to: '111',
        nick: 'DiscordUser',
        text: 'a video',
        isPrivate: false,
        extra: {
            files: [{ client: 'Discord', type: 'video', id: '1', size: 1000, url: 'https://cdn.example.invalid/v2.mp4' }],
        },
        handler: discordHandler,
    });
    await bridge2.send(videoCtx);

    assert.ok(calls.telegram.some(c => c.sendVideo === 'https://cdn.example.invalid/v2.mp4'), 'telegram gets inline video');
    assert.ok(calls.matrix.some(c => c.media && c.media.type === 'm.video'), 'matrix gets m.video');
    console.log('[7] servemedia=source: video type preserved and sent inline OK');

    // ------------------------------------------------ Matrix handler 消息解析（本地模拟事件）
    // 模拟 start() 的副作用：记录启动时间用于过滤旧消息
    matrixHandler._startTime = Date.now() - 60000;
    let parsed = null;
    matrixHandler.on('text', (c) => { parsed = c; });
    await matrixHandler._processMessage('!room:example.invalid', {
        sender: '@other:example.invalid',
        event_id: '$1',
        origin_server_ts: Date.now(),
        content: { msgtype: 'm.text', body: 'hi from matrix' },
    });
    assert.ok(parsed, 'matrix text event emitted');
    assert.strictEqual(parsed.text, 'hi from matrix');
    assert.strictEqual(parsed.to, '!room:example.invalid');

    // 自己的消息要被忽略
    parsed = null;
    await matrixHandler._processMessage('!room:example.invalid', {
        sender: '@bot:example.invalid',
        event_id: '$2',
        origin_server_ts: Date.now(),
        content: { msgtype: 'm.text', body: 'self' },
    });
    assert.strictEqual(parsed, null, 'own message ignored');

    // 旧消息忽略
    parsed = null;
    await matrixHandler._processMessage('!room:example.invalid', {
        sender: '@other:example.invalid',
        event_id: '$3',
        origin_server_ts: Date.now() - 3600000,
        content: { msgtype: 'm.text', body: 'old' },
    });
    assert.strictEqual(parsed, null, 'old message ignored');

    // 编辑消息忽略
    parsed = null;
    await matrixHandler._processMessage('!room:example.invalid', {
        sender: '@other:example.invalid',
        event_id: '$4',
        origin_server_ts: Date.now(),
        content: { msgtype: 'm.text', body: '* edited', 'm.relates_to': { rel_type: 'm.replace', event_id: '$1' } },
    });
    assert.strictEqual(parsed, null, 'edit (m.replace) ignored');
    console.log("[8] Matrix message parsing OK");

    // ------------------------------------------------ Discord splitText
    let parts = discordHandler.splitText('a'.repeat(2500) + '\nshort line', 2000);
    assert.ok(parts.length >= 2 && parts[0].length <= 2000, 'splitText respects limit');
    console.log('[9] Discord splitText OK');

    // ------------------------------------------------ QQ 本地文件路径映射
    const QQOnebot11MessageHandler = require('./lib/handlers/QQOnebot11MessageHandler.js');
    const qqHandler = new QQOnebot11MessageHandler({
        bot: { apiRoot: 'http://127.0.0.1:59999/', qq: '10000' },
        options: {
            pathMap: {
                '/app/.config/QQ': '/var/lib/docker/volumes/fakevol/_data',
                '/app/.config/QQ/videos': '/srv/videos',
            },
        },
    });
    assert.strictEqual(
        qqHandler._mapLocalPath('/app/.config/QQ/nt_qq_xxx/nt_data/Video/2026-09/Ori/abc.mp4'),
        '/var/lib/docker/volumes/fakevol/_data/nt_qq_xxx/nt_data/Video/2026-09/Ori/abc.mp4',
        'basic mapping');
    assert.strictEqual(
        qqHandler._mapLocalPath('/app/.config/QQ/videos/clip.mp4'),
        '/srv/videos/clip.mp4',
        'longest-prefix mapping wins');
    assert.strictEqual(
        qqHandler._mapLocalPath('/other/path/file.mp4'),
        '/other/path/file.mp4',
        'unmapped path returned as-is');
    console.log('[10] QQ local path mapping OK');

    // ------------------------------------------------ QQ get_file 视频获取（mock CQHttp）
    const os = require('os');
    const pathMod = require('path');
    const tmpDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'lwb-video-'));
    const norm = (p) => p.replace(/\\/g, '/');
    qqHandler._pathMap = { '/app/.config/QQ': tmpDir };  // 让映射目标指向本机临时目录
    const fakeContainerPath = '/app/.config/QQ/test.mp4';
    fs.writeFileSync(pathMod.join(tmpDir, 'test.mp4'), 'fake-video-content');
    // 情形1：get_file 返回本地路径（映射后存在且大小完整）
    const fakeContent = 'fake-video-content';
    qqHandler._client = async (action, params) => {
        assert.strictEqual(action, 'get_file');
        assert.strictEqual(params.file_id, 'nya.mp4');
        return { file: fakeContainerPath, url: fakeContainerPath, file_size: fakeContent.length };
    };
    let r1 = await qqHandler._fetchVideoFile(fakeContainerPath, [{ file: 'nya.mp4', url: fakeContainerPath }]);
    assert.ok(r1 && r1.path, 'get_file returns a path');
    assert.strictEqual(norm(r1.path), norm(pathMod.join(tmpDir, 'test.mp4')), 'path mapped into tmpDir');

    // 情形2：get_file 返回 http 链接
    qqHandler._client = async () => ({ url: 'https://cdn.example.invalid/v.mp4' });
    let r2 = await qqHandler._fetchVideoFile(fakeContainerPath, [{ file: 'nya.mp4', url: fakeContainerPath }]);
    assert.deepStrictEqual(r2, { url: 'https://cdn.example.invalid/v.mp4' }, 'get_file http url');

    // 情形3：API 抛错 → null
    qqHandler._client = async () => { throw new Error('boom'); };
    let r3 = await qqHandler._fetchVideoFile(fakeContainerPath, [{ file: 'nya.mp4', url: fakeContainerPath }]);
    assert.strictEqual(r3, null, 'get_file error returns null');

    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('[11] QQ get_file video fetching OK');

    // ------------------------------------------------ linkclean 插件（追踪参数清理）
    require('./plugins/linkclean.js')({ plugins: { transport: bridge2 }, global: {} }, {});
    calls.matrix.length = 0;
    let linkCtx = new Context({
        from: 'user1',
        to: '111',
        nick: 'Tester',
        text: '看这个 https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333.788&share_source=copy_web&p=2 和 https://example.org/page?utm_source=chat&utm_medium=x&id=9 好看',
        isPrivate: false,
        extra: {},
        handler: discordHandler,
    });
    await bridge2.send(linkCtx);

    assert.ok(calls.matrix.length >= 1, 'linkclean test message routed');
    let outText = calls.matrix.map(c => c.message).join(' ');
    assert.ok(!outText.includes('spm_id_from'), 'spm_id_from removed');
    assert.ok(!outText.includes('share_source'), 'share_source removed');
    assert.ok(!outText.includes('utm_source'), 'utm_source removed');
    assert.ok(outText.includes('p=2'), 'bilibili p=2 kept');
    assert.ok(outText.includes('BV1xx411c7mD'), 'video id kept');
    assert.ok(outText.includes('id=9'), 'generic id param kept');
    console.log('[12] linkclean tracking param cleanup OK');

    console.log('\nALL SMOKE TESTS PASSED');
    process.exit(0);
})().catch(e => {
    console.error('SMOKE TEST FAILED:', e);
    process.exit(1);
});
