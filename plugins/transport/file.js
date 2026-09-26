/*
 * 集中處理檔案：將檔案上傳到圖床，取得 URL 並儲存至 context 中
 *
 * 已知的問題：
 * Telegram 音訊使用 ogg 格式，QQ 則使用 amr 和 silk，這個可以考慮互相轉換一下
 *
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const sharp = require('sharp');
const winston = require('winston');
const fileType = require('file-type');

let options = {};
let servemedia;
let handlers;

const pkg = require('../../package.json');
const USERAGENT = `LilyWhiteBot/${pkg.version} (${pkg.repository})`;

/**
 * 根据已有文件名生成新文件名
 * @param {string} name 文件名
 * @returns {string} 新文件名
 */
const generateFileName = (url, name) => {
    let extName = path.extname(name || '');
    if (extName === '') {
        extName = path.extname(url || '');
    }
    if (extName === '.webp') {
        extName = '.png';
    }
    return crypto.createHash('md5').update(name || (Math.random()).toString()).digest('hex') + extName;
};

/**
 * 将各聊天软件的媒体类型转成标准类型
 * @param {string} type 各Handler提供的文件类型
 * @returns {string} 统一文件类型
 */
const convertFileType = (type) => {
    switch (type) {
        case 'sticker':
            return 'image';
        case 'voice':
            return 'audio';
        case 'document':
            return 'file';
        default:
            return type;  // video 等类型保留，供各平台以内嵌形式发送
    }
};

const streamToBuffer = (stream) => new Promise((resolve, reject) => {
    let buf = [];
    stream.on('data', d => buf.push(d));
    stream.on('end', () => resolve(Buffer.concat(buf)));
    stream.on('error', reject);
});

/**
 * 下载/获取文件内容，对文件进行格式转换（如果需要的话），然后管道出去
 * @param {*} file
 * @returns {Promise<stream.Readable>}
 */
const getFileStream = async (file) => {
    let filePath = file.url || file.path;
    // 防御：個別依賴（如 telegraf v4 的 getFileLink）可能返回 URL 對象
    if (typeof filePath !== 'string') {
        filePath = String(filePath);
    }
    let fileStream;

    if (file.url) {
        // 原生 fetch：超时只限制到响应头到达，正文按流读取
        let controller = new AbortController();
        let timer = setTimeout(() => controller.abort(), servemedia.timeout || 3000);
        let res;
        try {
            res = await fetch(file.url, { signal: controller.signal });
        } catch (e) {
            clearTimeout(timer);
            throw new Error(`Error fetching ${file.url}: ${e.message}`);
        }
        clearTimeout(timer);

        if (!res.ok) {
            throw new Error(`HTTP ${res.status} fetching ${file.url}`);
        }
        if (!res.body) {
            throw new Error(`Empty response fetching ${file.url}`);
        }

        fileStream = Readable.fromWeb(res.body);
    } else if (file.path) {
        fileStream = fs.createReadStream(file.path);
    } else {
        throw new TypeError('unknown file type');
    }

    // Telegram默认使用webp格式，转成png格式以便让其他聊天软件的用户查看
    if ((file.type === 'sticker' || file.type === 'image') && path.extname(filePath) === '.webp') {
        fileStream = fileStream.pipe(sharp().png());
    }

    return fileStream;
};

const pipeFileStream = (file, pipe) => new Promise(async (resolve, reject) => {
    try {
        let fileStream = await getFileStream(file);
        fileStream.on('error', e => reject(e))
            .on('end', () => resolve())
            .pipe(pipe);
    } catch (e) {
        reject(e);
    }
});

/*
 * 儲存至本機快取
 */
const uploadToCache = async (file) => {
    let targetName = generateFileName(String(file.url || file.path), file.id);
    let targetPath = path.join(servemedia.cachePath, targetName);
    let writeStream = fs.createWriteStream(targetPath).on('error', (e) => { throw e; });
    await pipeFileStream(file, writeStream);
    return servemedia.serveUrl + targetName;
};

/*
 * 上传到各种图床
 */
const uploadToHost = async (host, file) => {
    const timeout = servemedia.timeout || 3000;
    const useragent = servemedia.userAgent || USERAGENT;

    let name = generateFileName(String(file.url || file.path), file.id);

    // p4: reject .exe (complaint from the site admin)
    if (path.extname(name) === '.exe') {
        throw new Error('We wont upload .exe file');
    }

    let pendingFile = await streamToBuffer(await getFileStream(file));
    if (!path.extname(name)) {
        let type = await fileType.fromBuffer(pendingFile);
        if (type) name += '.' + type.ext;
    }

    let formData = new FormData();
    let headers = {
        'User-Agent': useragent,
    };
    let url = '';

    switch (host) {
        case 'vim-cn':
        case 'vimcn':
            url = 'https://img.vim-cn.com/';
            formData.append('name', new Blob([pendingFile]), name);
            break;

        case 'sm.ms':
            url = 'https://sm.ms/api/upload';
            formData.append('smfile', new Blob([pendingFile]), name);
            break;

        case 'imgur':
            if (servemedia.imgur.apiUrl.endsWith('/')) {
                url = servemedia.imgur.apiUrl + 'upload';
            } else {
                url = servemedia.imgur.apiUrl + '/upload';
            }
            headers.Authorization = `Client-ID ${servemedia.imgur.clientId}`;
            formData.append('type', 'file');
            formData.append('image', new Blob([pendingFile]), name);
            break;

        case 'uguu':
        case 'Uguu':
            url = servemedia.uguuApiUrl || servemedia.UguuApiUrl; // 原配置文件以大写字母开头
            formData.append('files[]', new Blob([pendingFile]), name);
            formData.append('randomname', 'true');
            break;

        case 'lsky':
            url = servemedia.lsky.apiUrl;
            if (servemedia.lsky.token) {
                headers.token = servemedia.lsky.token;
            }
            formData.append('image', new Blob([pendingFile]), name);
            break;

        default:
            throw new Error('Unknown host type');
    }

    let res = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: formData,
        signal: AbortSignal.timeout(timeout + 120000),  // 上传需要额外的时间余量
    });

    if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${url}`);
    }

    let bodyText = await res.text();
    let body;
    try {
        body = JSON.parse(bodyText);
    } catch (e) {
        body = bodyText;  // vim-cn、uguu 等返回纯文本直链
    }

    switch (host) {
        case 'vim-cn':
        case 'vimcn':
            return body.trim().replace('http://', 'https://');
        case 'uguu':
        case 'Uguu':
            return body.trim();
        case 'sm.ms':
            if (body && body.code !== 'success') {
                throw new Error(`sm.ms return: ${body.msg}`);
            }
            return body.data.url;
        case 'imgur':
            if (body && !body.success) {
                throw new Error(`Imgur return: ${body.data && body.data.error}`);
            }
            return body.data.link;
        case 'lsky':
            if (body && body.code !== 200) {
                throw new Error(`Lsky return: ${body.msg}`);
            }
            return body.data.url;
    }
};

/*
 * 上傳到自行架設的 linx 圖床上面
 */
const uploadToLinx = async (file) => {
    let name = generateFileName(String(file.url || file.path), file.id);

    let pendingFile = await streamToBuffer(await getFileStream(file));

    let res = await fetch(servemedia.linxApiUrl + name, {
        method: 'PUT',
        headers: {
            'User-Agent': servemedia.userAgent || USERAGENT,
            'Linx-Randomize': 'yes',
            'Accept': 'application/json',
            'Content-Type': 'application/octet-stream',
        },
        body: pendingFile,
        signal: AbortSignal.timeout((servemedia.timeout || 3000) + 120000),
    });

    if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${servemedia.linxApiUrl}`);
    }

    return (await res.json()).direct_url;
};

/*
 * 決定檔案去向
 */
const uploadFile = async (file) => {
    let url;
    let fileType = convertFileType(file.type);

    switch (servemedia.type) {
        case 'vimcn':
        case 'vim-cn':
        case 'uguu':
        case 'Uguu':
        case 'lsky':
            url = await uploadToHost(servemedia.type, file);
            break;

        case 'sm.ms':
        case 'imgur':
            // 公共图床只接受图片，不要上传其他类型文件
            if (fileType === 'image') {
                url = await uploadToHost(servemedia.type, file);
            }
            break;

        case 'self':
            url = await uploadToCache(file);
            break;

        case 'linx':
            url = await uploadToLinx(file);
            break;

        case 'source':
            // 直接使用原網址
            url = file.url;
            break;

        default:

    }

    if (url) {
        return {
            type: fileType,
            url: url
        };
    } else {
        return null;
    }
};

/*
 * 判斷訊息來源，將訊息中的每個檔案交給對應函式處理
 */
const fileUploader = {
    init: (opt) => {
        options = opt;
        servemedia = options.options.servemedia || {};
    },
    get handlers() { return handlers; },
    set handlers(h) { handlers = h; },
    process: async (context) => {
        // 上传文件
        // p4: dont bother with files from somewhere without bridges in config
        if (context.extra.clients > 1 && context.extra.files && servemedia.type && servemedia.type !== 'none') {
            let promises = [];
            let fileCount = context.extra.files.length;

            // 将聊天消息附带文件上传到服务器
            for (let [index, file] of context.extra.files.entries()) {
                if (servemedia.sizeLimit && servemedia.sizeLimit > 0 && file.size && file.size > servemedia.sizeLimit*1024) {
                    winston.debug(`[file.js] <FileUploader> #${context.msgId} File ${index+1}/${fileCount}: Size limit exceeded. Ignore.`);
                } else {
                    promises.push(uploadFile(file));
                }
            }

            // 整理上传到服务器之后到URL
            let uploads = (await Promise.all(promises)).filter(x => x);
            for (let [index, upload] of uploads.entries()) {
                winston.debug(`[file.js] <FileUploader> #${context.msgId} File ${index+1}/${uploads.length} (${upload.type}): ${upload.url}`);
            }

            return uploads;
        } else {
            return [];
        }
    },
};

module.exports = (bridge, options) => {
    fileUploader.init(options);
    fileUploader.handlers = bridge.handlers;

    bridge.addHook('bridge.send', async (msg) => {
        try {
            msg.extra.uploads = await fileUploader.process(msg);
        } catch (e) {
            winston.error(`Error on processing files: `, e);
            bridge.send(new bridge.BridgeMsg(msg, {
                text: 'File upload error',
                isNotice: true,
                extra: {},
            }));
        }
    });
};
