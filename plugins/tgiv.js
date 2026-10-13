/*
 * tgiv.js Telegram Instant View 私聊工具
 *
 * 在 Telegram 私聊中将链接转换为 Instant View（即时预览）：
 * - 私聊发送 /iv <链接>，机器人回一条该链接的消息；
 *   若页面存在 Telegram Instant View 模板，消息下会自动出现「Instant View」按钮，
 *   点开即是免广告、秒开的干净阅读页。
 * - 私聊发送「只有一条裸链接」的消息时也可自动触发（可用 options.autoUrl: false 关闭）。
 *
 * 说明：
 * 1. Instant View 按钮由 Telegram 服务器自动附加，是否可用取决于目标页面是否
 *    存在 IV 模板（多数新闻、博客、百科类页面可用）；没有模板时仍会显示普通预览。
 * 2. 仅在私聊生效，不会影响群组互联消息。
 *
 * 配置（config.yml）：
 *
 * plugins:
 *   - tgiv
 *
 * tgiv:
 *   autoUrl: true        # 私聊收到裸链接时自动转换（默认开启）
 */

'use strict';

const winston = require('winston');

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/iu;

module.exports = (pluginManager, options) => {
    const tg = pluginManager.handlers.get('Telegram');

    if (!tg) {
        winston.error('[tgiv] Telegram handler not loaded, tgiv disabled.');
        return;
    }

    const autoUrl = options.autoUrl !== false;

    // 发送带预览的链接消息（Instant View 按钮由 Telegram 自动附加）
    const sendIV = async (chatId, url) => {
        try {
            await tg.say(chatId, url);
        } catch (e) {
            winston.error(`[tgiv] failed to send IV message: ${e.message}`);
        }
    };

    // /iv 命令（私聊）
    tg.addCommand('iv', (context, cmd, param) => {
        if (!context.isPrivate) {
            return;
        }

        let url = param.trim();
        if (!url) {
            const m = context.text.match(URL_REGEX);
            url = m && m[0];
        }

        if (!url) {
            tg.reply(context, '用法：/iv <链接>\n例如 /iv https://example.com/article');
            return;
        }

        sendIV(context.from, url);
    });

    // 私聊裸链接自动触发
    if (autoUrl) {
        tg.on('text', (context) => {
            if (!context.isPrivate || context.command) {
                return;
            }
            // 非命令消息且整条消息基本就是一个链接时自动转换
            const text = context.text.trim();
            if (/^https?:\/\/\S+$/iu.test(text)) {
                sendIV(context.from, text);
            }
        });
    }
};
