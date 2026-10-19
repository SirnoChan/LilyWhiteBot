/*
* Get qq multi forward messages
*
* command: '!qmulti'
* types: [
*     'qq/123456'
* ]
*/

'use strict';

const format = require('string-format');

module.exports = (pluginManager, options) => {
    const bridge = pluginManager.plugins.transport;

    if (!bridge || !pluginManager.handlers.has('QQ')) {
        return;
    }

    let command = options.command || '!qmulti';

    const commandCallback = (context) => {
        if (context.isPrivate) {
          const client = context.handler.type;
          if (['Telegram', 'IRC', 'Discord', 'QQ', 'Matrix'].includes(client)) {
              let handler = pluginManager.handlers.get(client);
              let qqHandler = pluginManager.handlers.get('QQ');
              qqHandler.getForwardMsg(context.param.split(' ')[0]).then(res=>{
                // QQ/IRC 私聊的 to 是機器人自身，回覆目標應為發起查詢的用戶
                let target = ['IRC', 'QQ'].includes(client) ? context.from : context.to;
                if (res.status=='ok') {
                  let msgArray = [];
                  if (Array.isArray(res.data)) {
                    // OICQ 格式
                    msgArray = res.data;
                  } else if (Array.isArray(res.data.message)) {
                    // Onebot v11 格式
                    msgArray = res.data.message;
                  } else if (Array.isArray(res.data.messages)) {
                    // NapCat 格式
                    msgArray = res.data.messages;
                  }
                  msgArray.forEach(msg=>{
                    let message = qqHandler.parseMessage(msg.message||msg.content);
                    let meta = {
                        nick: msg.sender?.nickname || msg.sender?.user_id
                          || msg.nickname || msg.user_id,
                        from: msg.user_id,
                        to: msg.group_id,
                        text: message.text,
                        client_short: 'Q',
                        client_full: 'QQ',
                    };
                    
                    
                    if (message.extra.multimsg) {
                      meta.text+=`\n[私聊机器人使用 ${command} ${message.extra.multimsg[0]} 以${message.extra.multimsg[1]}]`;
                    } else if (message.extra.forward) {
                      meta.text+=`\n[私聊机器人使用 ${command} ${message.extra.forward[0]} 以查看转发消息]`;
                    }
                    
                    let output = format('[{nick}] {text}', meta);
                    
                    // 处理图片和音频附件
                    for (let file of message.extra.images) {
                        output += '\n' + file;
                    }
                    for (let file of message.extra.records) {
                        output += '\n' + file;
                    }
                    for (let file of message.extra.videos) {
                        output += '\n' + file;
                    }
                    
                    handler.say(target, output);
                  })
                } else {
                  handler.say(target, `找不到指定的合并转发消息。`);
                }
              });
              
          }
        }
    };

    // handler 层命令：Telegram 的命令消息被 processor 过滤（不进 bridge.send），
    // 挂在 bridge.send hook 上的命令在 TG 永不触发，因此直接注册到各平台 handler。
    // Telegram 的命令前缀固定为 /，其余平台用配置的完整前缀（!qmulti）。
    for (const client of ['Telegram', 'IRC', 'Discord', 'QQ', 'Matrix']) {
        if (pluginManager.handlers.has(client)) {
            pluginManager.handlers.get(client).addCommand(
                client === 'Telegram' ? command.replace(/^!/, '/') : command,
                commandCallback,
            );
        }
    }
};
