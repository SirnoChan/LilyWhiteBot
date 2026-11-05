/*
 * zcode-tg —— ZCode 服务端代理的 Telegram 控制端（独立进程）
 *
 * 命令（私聊）：
 *   /start        首次使用自动注册为管理员（引导期），回显你的 TG id
 *   /id           查看自己的 TG id
 *   /zcode <任务> 在服务器上以无头模式运行 ZCode agent（工作目录 = LWBot 仓库）
 *   /mode <m>     切换 ZCode 权限模式：plan | edit | yolo | guarded
 *   /status       查看状态
 *
 * 安全：只有 adminIds 里的账号能用 /zcode、/mode；首个 /start 引导为管理员。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const API = `https://api.telegram.org/bot${CFG.token}`;
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);

let adminIds = new Set(CFG.adminIds || []);
const saveAdmins = () => {
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
        cfg.adminIds = [...adminIds];
        fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(cfg, null, 4));
    } catch (e) {
        console.error('saveAdmins failed:', e.message);
    }
};

let mode = CFG.mode || 'edit';
let busy = false;

const tgApi = async (method, payload) => {
    const res = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(45000),
    });
    return res.json();
};

const send = async (chatId, text) => {
    await tgApi('sendMessage', { chat_id: chatId, text: String(text).slice(0, 3800) });
};

const runZcode = (chatId, task) => {
    if (busy) {
        return void send(chatId, '（上一个任务还在跑）');
    }
    busy = true;
    send(chatId, `⏳ ZCode [${mode}] 开始：${task.slice(0, 100)}`).catch(() => {});
    execFile(
        process.execPath,
        [CFG.zcodeCli, '-p', task, '--output-format', 'text', '--mode', mode],
        { cwd: CFG.workDir, timeout: (CFG.timeoutSec || 300) * 1000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
            busy = false;
            let out = String(stdout || '').trim();
            if (!out && stderr) out = '[stderr] ' + String(stderr).trim();
            if (!out && err) out = '❌ ' + String(err.message).slice(0, 300);
            if (!out) out = '（无输出）';
            const note = err ? '\n\n⚠️ 超时或异常退出' : '';
            send(chatId, out.slice(0, CFG.maxChars || 3000) + (out.length > (CFG.maxChars || 3000) ? '\n…（已截断）' : '') + note)
                .catch((e) => log('send failed:', e.message));
            log(`task done (${out.length}B): ${task.slice(0, 60)}`);
        }
    ).on('error', (e) => {
        busy = false;
        log('spawn error:', e.message);
    });
};

const onMessage = async (m) => {
    const chatId = m.chat && m.chat.id;
    const uid = String(m.from && m.from.id);
    const text = String(m.text || '').trim();
    if (!chatId || !text) return;
    if (m.chat.type !== 'private') return;   // 仅私聊

    if (/^\/(start|id)$/u.test(text)) {
        if (!adminIds.size) {
            adminIds.add(uid);
            saveAdmins();
            log(`BOOTSTRAP: first user enrolled as admin: ${uid} (${m.from.username || ''})`);
            return void send(chatId, `已注册为管理员（TG id: ${uid}）。用法：/zcode 任务描述`);
        }
        return void send(chatId, `你的 TG id: ${uid}`);
    }

    if (!adminIds.has(uid)) {
        return void send(chatId, `未授权（你的 id: ${uid}）`);
    }

    const zc = text.match(/^\/zcode\s+([\s\S]+)$/u);
    if (zc) {
        return runZcode(chatId, zc[1].trim());
    }
    if (/^\/mode\s+(plan|edit|yolo|guarded)$/u.test(text)) {
        mode = text.split(/\s+/u)[1];
        return void send(chatId, `权限模式已切换为 ${mode}`);
    }
    if (/^\/status$/u.test(text)) {
        return void send(chatId, `mode=${mode} | busy=${busy} | admins=${adminIds.size} | cli=${CFG.zcodeCli}`);
    }
    if (/^\/zcode$/u.test(text)) {
        return void send(chatId, '用法：/zcode 任务描述');
    }
};

let offset = 0;
const poll = async () => {
    while (true) {
        try {
            const res = await tgApi('getUpdates', { timeout: 30, offset });
            if (res.ok && Array.isArray(res.result)) {
                for (const u of res.result) {
                    offset = u.update_id + 1;
                    if (u.message) onMessage(u.message).catch((e) => log('msg error:', e.message));
                }
            } else {
                log('getUpdates error:', JSON.stringify(res).slice(0, 150));
                await new Promise((r) => setTimeout(r, 5000));
            }
        } catch (e) {
            log('poll error:', e.message);
            await new Promise((r) => setTimeout(r, 5000));
        }
    }
};

log(`zcode-tg starting; admins: ${adminIds.size}; cli: ${CFG.zcodeCli}; mode: ${mode}`);
poll();
