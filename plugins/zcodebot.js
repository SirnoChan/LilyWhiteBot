/*
 * zcodebot —— 电报私聊专用的 ZCode agent 控制命令
 *
 * 私聊 Lily-White_Bot 发送：/zcode 任务描述
 * → 在服务器上以无头模式运行 ZCode CLI（GLM 订阅模型），
 *   工作目录 = LWBot 仓库，执行完毕把结果回给你。
 *
 * config.yml：
 *
 * zcodebot:
 *   adminTelegramIds: []        # 允许使用的 Telegram 数字 id（空 = 拒绝并提示 id）
 *   zcodeCli: "/srv/lwb/zcode-agent/zcode.cjs"
 *   workDir: "/srv/lwb/LilyWhiteBot"
 *   mode: "edit"                # ZCode 权限模式：plan(只读)/edit(自动改文件)/yolo/guarded
 *   timeoutSec: 300
 *   maxChars: 3000
 *
 * 安全：仅限 Telegram 私聊 + 管理员白名单；群聊中一律忽略。
 */

'use strict';

const { execFile } = require('child_process');
const winston = require('winston');

module.exports = (pluginManager, options) => {
    const tg = pluginManager.handlers.get('Telegram');
    if (!tg) {
        winston.error('[zcodebot] Telegram handler not loaded, zcodebot disabled.');
        return;
    }

    const adminIds = (options.adminTelegramIds || []).map(String);
    const zcodeCli = options.zcodeCli || '/srv/lwb/zcode-agent/zcode.cjs';
    const workDir = options.workDir || '/srv/lwb/LilyWhiteBot';
    const mode = options.mode || 'edit';
    const timeoutMs = (options.timeoutSec || 300) * 1000;
    const maxChars = options.maxChars || 3000;

    let busy = false;

    const handler = (context, cmd, param) => {
        // 只有电报私聊 + 管理员
        if (context.handler.type !== 'Telegram' || !context.isPrivate) {
            return;
        }
        const uid = String(context.from);
        if (adminIds.indexOf(uid) === -1) {
            winston.warn(`[zcodebot] unauthorized attempt from TG uid ${uid}`);
            context.reply(`（未授权。你的 TG id: ${uid}，请把它加进 zcodebot.adminTelegramIds）`);
            return;
        }

        const task = String(param || '').trim();
        if (!task) {
            context.reply('用法：/zcode 任务描述\n例如 /zcode 查看 LWBot 日志里最近的报错');
            return;
        }
        if (busy) {
            context.reply('（上一个任务还在跑，稍等）');
            return;
        }
        busy = true;
        context.reply('⏳ ZCode 开始执行：' + task.slice(0, 100)).catch(() => {});

        const child = execFile(
            process.execPath,
            [zcodeCli, '-p', task, '--output-format', 'text', '--mode', mode],
            { cwd: workDir, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
            (err, stdout, stderr) => {
                busy = false;
                if (err && !stdout) {
                    winston.warn(`[zcodebot] task failed: ${err.message}`);
                    context.reply(`❌ 执行失败：${String(err.message).slice(0, 300)}`).catch(() => {});
                    return;
                }
                let out = String(stdout || '').trim();
                if (!out && stderr) out = '[stderr] ' + String(stderr).trim();
                if (!out) out = '（无输出）';
                const note = err ? '\n\n⚠️ 进程超时或异常退出' : '';
                context.reply(out.slice(0, maxChars) + (out.length > maxChars ? '\n…（已截断）' : '') + note)
                    .catch((e) => winston.warn(`[zcodebot] reply failed: ${e.message}`));
                winston.info(`[zcodebot] task done (${(out || '').length}B): ${task.slice(0, 60)}`);
            }
        );
        child.on('error', (e) => winston.error(`[zcodebot] spawn error: ${e.message}`));
    };

    tg.addCommand('!zcode', handler);
    tg.addCommand('/zcode', handler);
    winston.info(`[zcodebot] /zcode ready (TG private only, admins: ${adminIds.length}, mode: ${mode})`);
};
