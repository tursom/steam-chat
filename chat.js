const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { once } = require('node:events');

const axios = require('axios');
const dateformat = require('@matteo.collina/dateformat');
const WebSocket = require('ws');

const CHAT_LOG_FILE = './logs/chat.jsonl';
const STICKER_CACHE_DIR = './logs/stickers';
const IMAGE_CACHE_DIR = './logs/images';

function normalizeAuthConfig(rawAuth) {
    const defaultConfig = {
        username: '',
        password: '',
        realm: 'Steam Chat',
        trustProxy: false,
    };

    if (!rawAuth || typeof rawAuth !== 'object') {
        return defaultConfig;
    }

    return {
        username: rawAuth.username || '',
        password: rawAuth.password || '',
        realm: rawAuth.realm || defaultConfig.realm,
        trustProxy: rawAuth.trustProxy === true,
    };
}

function normalizeChatConfig(rawConfig) {
    const defaultConfig = {
        enabled: Boolean(rawConfig),
        host: '0.0.0.0',
        port: 3000,
        wsPath: '/ws',
        auth: normalizeAuthConfig(null),
    };

    if (!rawConfig || typeof rawConfig !== 'object') {
        return defaultConfig;
    }

    return {
        enabled: rawConfig.enabled !== false,
        host: rawConfig.host || defaultConfig.host,
        port: rawConfig.port || defaultConfig.port,
        wsPath: rawConfig.wsPath || defaultConfig.wsPath,
        auth: normalizeAuthConfig(rawConfig.auth),
    };
}

function normalizeIpAddress(rawAddress) {
    let address = String(rawAddress || '').trim();
    if (!address) {
        return '';
    }

    const forwardedMatch = address.match(/^for=(.+)$/i);
    if (forwardedMatch) {
        address = forwardedMatch[1];
    }

    address = address.replace(/^"|"$/g, '');

    if (address.startsWith('[')) {
        const closingIndex = address.indexOf(']');
        if (closingIndex !== -1) {
            address = address.slice(1, closingIndex);
        }
    } else if ((address.match(/:/g) || []).length === 1 && address.includes('.')) {
        address = address.split(':')[0];
    }

    address = address.replace(/^\[|\]$/g, '').replace(/%[0-9a-z]+$/i, '').trim().toLowerCase();

    if (address.startsWith('::ffff:')) {
        return address.slice('::ffff:'.length);
    }

    return address;
}

function parseForwardedHeader(headerValue) {
    if (!headerValue) {
        return '';
    }

    for (const part of String(headerValue).split(',')) {
        for (const segment of part.split(';')) {
            const match = segment.trim().match(/^for=(.+)$/i);
            if (match && match[1]) {
                return normalizeIpAddress(match[1]);
            }
        }
    }

    return '';
}

function getClientIp(req, trustProxy = false) {
    const headers = req && req.headers ? req.headers : {};

    if (trustProxy) {
        const forwarded = parseForwardedHeader(headers.forwarded);
        if (forwarded) {
            return forwarded;
        }

        const xForwardedFor = String(headers['x-forwarded-for'] || '')
            .split(',')
            .map((item) => normalizeIpAddress(item))
            .find(Boolean);
        if (xForwardedFor) {
            return xForwardedFor;
        }

        const xRealIp = normalizeIpAddress(headers['x-real-ip']);
        if (xRealIp) {
            return xRealIp;
        }
    }

    return normalizeIpAddress(
        (req && req.socket && req.socket.remoteAddress)
        || (req && req.connection && req.connection.remoteAddress)
        || '',
    );
}

function isLanIp(rawAddress) {
    const address = normalizeIpAddress(rawAddress);
    if (!address) {
        return false;
    }

    if (address === '::1' || address === 'localhost') {
        return true;
    }

    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) {
        if (address.startsWith('10.') || address.startsWith('127.') || address.startsWith('192.168.') || address.startsWith('169.254.')) {
            return true;
        }

        const octets = address.split('.').map((item) => Number.parseInt(item, 10));
        if (octets.length === 4 && octets.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
            return octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31;
        }

        return false;
    }

    return address.startsWith('fc')
        || address.startsWith('fd')
        || address.startsWith('fe8')
        || address.startsWith('fe9')
        || address.startsWith('fea')
        || address.startsWith('feb');
}

function isAuthEnabled(authConfig) {
    return Boolean(authConfig && authConfig.username && authConfig.password);
}

function hashSecret(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest();
}

function safeEqual(left, right) {
    return crypto.timingSafeEqual(hashSecret(left), hashSecret(right));
}

function parseBasicAuthHeader(headerValue) {
    const match = String(headerValue || '').match(/^Basic\s+(.+)$/i);
    if (!match) {
        return null;
    }

    try {
        const decoded = Buffer.from(match[1], 'base64').toString('utf8');
        const separatorIndex = decoded.indexOf(':');
        if (separatorIndex === -1) {
            return null;
        }

        return {
            username: decoded.slice(0, separatorIndex),
            password: decoded.slice(separatorIndex + 1),
        };
    } catch (err) {
        return null;
    }
}

function isAuthorized(req, authConfig) {
    if (!isAuthEnabled(authConfig)) {
        return true;
    }

    const credentials = parseBasicAuthHeader(req && req.headers ? req.headers.authorization : '');
    if (!credentials) {
        return false;
    }

    return safeEqual(credentials.username, authConfig.username)
        && safeEqual(credentials.password, authConfig.password);
}

function requiresHttpAuth(req, chatConfig) {
    if (!isAuthEnabled(chatConfig && chatConfig.auth)) {
        return false;
    }

    return !isLanIp(getClientIp(req, chatConfig.auth.trustProxy));
}

function normalizeWsRequest(payload) {
    switch (payload.type) {
        case 'msg':
        case 'send_message':
            return {
                action: 'send_message',
                requestId: payload.requestId,
                id: payload.id,
                msg: payload.msg,
            };
        case 'img':
        case 'send_image':
            return {
                action: 'send_image',
                requestId: payload.requestId,
                id: payload.id,
                img: payload.img,
                url: payload.url,
            };
        case 'history':
        case 'get_history':
            return {
                action: 'get_history',
                requestId: payload.requestId,
                id: payload.id,
                limit: payload.limit,
            };
        case 'conversations':
        case 'get_conversations':
            return {
                action: 'get_conversations',
                requestId: payload.requestId,
                limit: payload.limit,
            };
        case 'emoticons':
        case 'get_emoticons':
            return {
                action: 'get_emoticons',
                requestId: payload.requestId,
            };
        case 'ping':
            return {
                action: 'ping',
                requestId: payload.requestId,
            };
        default:
            return {
                action: payload.type,
                requestId: payload.requestId,
                ...payload,
            };
    }
}

function buildMessageKey(message) {
    return `${message.id}:${message.ordinal}:${message.message}`;
}

function normalizeHistoryEntry(entry) {
    if (!entry || typeof entry !== 'object') {
        return null;
    }

    return {
        type: entry.type || (entry.imageUrl ? 'image' : 'message'),
        date: entry.date || '',
        echo: Boolean(entry.echo),
        id: entry.id || '',
        name: entry.name || '',
        message: entry.message || '',
        imageUrl: entry.imageUrl || null,
        ordinal: typeof entry.ordinal === 'number' ? entry.ordinal : null,
        sentAt: entry.sentAt || null,
    };
}

function sanitizeLimit(limit, fallback = 100) {
    const value = Number.parseInt(limit, 10);
    if (!Number.isFinite(value) || value <= 0) {
        return fallback;
    }
    return Math.min(value, 500);
}

function extractStickerType(message) {
    if (typeof message !== 'string') {
        return null;
    }

    const match = message.match(/\[sticker\s+type="([^"]+)"/i);
    return match ? match[1] : null;
}

function extractEmoticonNames(message) {
    if (typeof message !== 'string') {
        return [];
    }

    const names = new Set();

    for (const match of message.matchAll(/\[emoticon\s+name="([^"]+)"\](?:\[\/emoticon\])?/gi)) {
        if (match[1]) {
            names.add(match[1]);
        }
    }

    for (const match of message.matchAll(/\[emoticon\]([^\[]+)\[\/emoticon\]/gi)) {
        if (match[1]) {
            names.add(match[1].trim());
        }
    }

    for (const match of message.matchAll(/(^|\s):([a-z0-9_][a-z0-9_\-]*):(?=\s|$|[!?,.])/gi)) {
        if (match[2]) {
            names.add(match[2]);
        }
    }

    return [...names];
}

function extractImageUrls(message) {
    if (typeof message !== 'string') {
        return [];
    }

    const urls = new Set();

    for (const match of message.matchAll(/\[img\](https?:\/\/[^\s[\]]+?)\[\/img\]/gi)) {
        if (match[1]) {
            urls.add(match[1]);
        }
    }

    for (const match of message.matchAll(/\[img\s+src=(https?:\/\/\S+?)[\s\]]/gi)) {
        if (match[1]) {
            urls.add(match[1]);
        }
    }

    for (const match of message.matchAll(/<img\b[^>]*?\bsrc=["'](https?:\/\/[^"']+)["'][^>]*>/gi)) {
        if (match[1]) {
            urls.add(match[1]);
        }
    }

    for (const match of message.matchAll(/https?:\/\/\S+?(?:png|jpe?g|gif|webp|bmp)(?:\?\S*)?/gi)) {
        if (match[0]) {
            urls.add(match[0]);
        }
    }

    return [...urls];
}

function parseBbCodeAttributes(rawAttributes) {
    const attrs = {};
    const content = String(rawAttributes || '');
    const attributeRegex = /([a-z][a-z0-9_-]*)=(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s"'=<>`]+))/gi;
    let match;

    while ((match = attributeRegex.exec(content)) !== null) {
        const key = match[1].toLowerCase();
        const value = match[2] ?? match[3] ?? match[4] ?? '';
        attrs[key] = value.replace(/\\(["'])/g, '$1');
    }

    return attrs;
}

function extractOpenGraphEmbeds(message) {
    if (typeof message !== 'string') {
        return [];
    }

    const embeds = [];

    for (const match of message.matchAll(/\[og\s+([^\]]+)\]([\s\S]*?)\[\/og\]/gi)) {
        const attrs = parseBbCodeAttributes(match[1] || '');
        const fallbackUrl = (match[2] || '').trim();

        embeds.push({
            url: attrs.url || fallbackUrl,
            img: attrs.img || null,
            title: attrs.title || '',
        });
    }

    return embeds.filter((item) => item.url);
}

function buildSteamEmoticonUrl(name, large = true) {
    const normalized = String(name || '').trim().replace(/^:+|:+$/g, '');
    if (!normalized) {
        return null;
    }

    const sizePath = large ? 'emoticonlarge' : 'emoticon';
    return `https://steamcommunity-a.akamaihd.net/economy/${sizePath}/${encodeURIComponent(normalized)}`;
}

function buildSteamStickerCandidateUrls(type) {
    const normalized = String(type || '').trim();
    if (!normalized) {
        return [];
    }

    return [
        `https://steamcommunity-a.akamaihd.net/economy/sticker/${encodeURIComponent(normalized)}`,
        `https://steamcommunity-a.akamaihd.net/economy/stickerlarge/${encodeURIComponent(normalized)}`,
        `https://steamcommunity.com/economy/sticker/${encodeURIComponent(normalized)}`,
        `https://steamcommunity.com/economy/stickerlarge/${encodeURIComponent(normalized)}`,
    ];
}

function buildStickerCachePath(type) {
    const normalized = String(type || '').trim();
    if (!normalized) {
        return path.join(STICKER_CACHE_DIR, 'unknown.png');
    }

    return path.join(STICKER_CACHE_DIR, `${encodeURIComponent(normalized)}.bin`);
}

function buildImageCachePaths(url) {
    const normalized = String(url || '').trim();
    const hash = crypto.createHash('sha1').update(normalized).digest('hex');
    return {
        dataPath: path.join(IMAGE_CACHE_DIR, `${hash}.bin`),
        metaPath: path.join(IMAGE_CACHE_DIR, `${hash}.json`),
    };
}

function guessImageContentType(url, fallback = 'image/png') {
    const pathname = String(url || '').split('?')[0].toLowerCase();
    if (pathname.endsWith('.png')) {
        return 'image/png';
    }
    if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) {
        return 'image/jpeg';
    }
    if (pathname.endsWith('.gif')) {
        return 'image/gif';
    }
    if (pathname.endsWith('.webp')) {
        return 'image/webp';
    }
    if (pathname.endsWith('.bmp')) {
        return 'image/bmp';
    }
    if (pathname.endsWith('.svg')) {
        return 'image/svg+xml';
    }
    return fallback;
}

function buildConversationPreview(entry) {
    if (!entry) {
        return '';
    }

    if (entry.type === 'image' || entry.imageUrl) {
        return '[图片]';
    }

    const ogEmbeds = extractOpenGraphEmbeds(entry.message);
    if (ogEmbeds.length > 0) {
        return ogEmbeds[0].title || ogEmbeds[0].url || '[链接预览]';
    }

    if (extractImageUrls(entry.message).length > 0) {
        return '[图片]';
    }

    const stickerType = extractStickerType(entry.message);
    if (stickerType) {
        return `[贴纸] ${stickerType.replace(/^Sticker_/, '')}`;
    }

    const emoticonNames = extractEmoticonNames(entry.message);
    const emoticonOnlyText = String(entry.message || '')
        .replace(/\[emoticon\s+name="([^"]+)"\](?:\[\/emoticon\])?/gi, (_, name) => `:${name}:`)
        .replace(/\[emoticon\]([^\[]+)\[\/emoticon\]/gi, (_, name) => `:${name.trim()}:`)
        .trim()
        .replace(/\s+/g, '');
    if (emoticonNames.length && emoticonOnlyText === emoticonNames.map((name) => `:${name}:`).join('')) {
        return `[表情] ${emoticonNames.join(' ')}`;
    }

    return String(entry.message || '').trim().replace(/\s+/g, ' ').slice(0, 60);
}

function sortHistoryItems(items) {
    return [...items].sort((left, right) => {
        const leftDate = left.date || left.sentAt || '';
        const rightDate = right.date || right.sentAt || '';

        if (leftDate !== rightDate) {
            return leftDate.localeCompare(rightDate);
        }

        const leftOrdinal = typeof left.ordinal === 'number' ? left.ordinal : Number.MAX_SAFE_INTEGER;
        const rightOrdinal = typeof right.ordinal === 'number' ? right.ordinal : Number.MAX_SAFE_INTEGER;

        return leftOrdinal - rightOrdinal;
    });
}

function buildConversationSummaries(items) {
    const conversations = new Map();

    for (const entry of sortHistoryItems(items)) {
        if (!entry.id) {
            continue;
        }

        const current = conversations.get(entry.id) || {
            id: entry.id,
            name: entry.name || '',
            updatedAt: entry.date || entry.sentAt || '',
            preview: buildConversationPreview(entry),
            lastType: entry.type || (entry.imageUrl ? 'image' : 'message'),
            lastEcho: Boolean(entry.echo),
            messageCount: 0,
        };

        current.name = entry.name || current.name;
        current.updatedAt = entry.date || entry.sentAt || current.updatedAt;
        current.preview = buildConversationPreview(entry) || current.preview;
        current.lastType = entry.type || (entry.imageUrl ? 'image' : 'message');
        current.lastEcho = Boolean(entry.echo);
        current.messageCount += 1;

        conversations.set(entry.id, current);
    }

    return [...conversations.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

const PUBLIC_DIR = path.join(__dirname, 'public');

const STATIC_CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
};

function serveStaticFile(res, filePath) {
    const ext = path.extname(filePath) || '.html';
    const contentType = STATIC_CONTENT_TYPES[ext];
    if (!contentType) {
        res.writeHead(404);
        res.end('Not Found');
        return;
    }

    const fullPath = path.join(PUBLIC_DIR, filePath);
    const normalized = path.normalize(fullPath);
    if (!normalized.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.readFile(normalized, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
}

function getDefaultDeps() {
    const config = require('./config.js');
    const client = require('./client');

    return {
        rawChatConfig: config.chat,
        client,
        logger: client.logger,
        steamUser: client.steamUser,
        steamCommunity: client.steamCommunity,
        fsModule: fs,
        httpModule: http,
        onceFn: once,
        axiosInstance: axios,
        WebSocketImpl: WebSocket,
        dateToString: (date) => dateformat(date, 'yyyy-mm-dd HH:MM:ss.l'),
    };
}

function createChatService(customDeps = {}) {
    const baseDeps = customDeps.useDefaultDeps === false ? {} : getDefaultDeps();
    const deps = {
        ...baseDeps,
        ...customDeps,
    };

    delete deps.useDefaultDeps;

    const {
        rawChatConfig,
        client,
        logger,
        steamUser,
        steamCommunity,
        fsModule,
        httpModule,
        onceFn,
        axiosInstance,
        WebSocketImpl,
        dateToString,
    } = deps;

    const chatConfig = normalizeChatConfig(rawChatConfig);
    const recentSelfMessages = new Map();
    const recentSelfImageUrls = new Map();
    const pendingStickerFetches = new Map();
    const pendingImageFetches = new Map();
    let started = false;

    fsModule.mkdir('./logs', { recursive: true }, (err) => {
        if (err) {
            logger.error('an error occurred while creating the logs directory: ' + err);
        }
    });
    fsModule.mkdir(STICKER_CACHE_DIR, { recursive: true }, (err) => {
        if (err) {
            logger.error('an error occurred while creating the sticker cache directory: ' + err);
        }
    });
    fsModule.mkdir(IMAGE_CACHE_DIR, { recursive: true }, (err) => {
        if (err) {
            logger.error('an error occurred while creating the image cache directory: ' + err);
        }
    });

    const server = httpModule.createServer(handleHttp);
    const wss = new WebSocketImpl.Server({
        server,
        path: chatConfig.wsPath,
        verifyClient: (info, done) => {
            if (!requiresHttpAuth(info.req, chatConfig) || isAuthorized(info.req, chatConfig.auth)) {
                done(true);
                return;
            }

            done(false, 401, 'Authentication Required', {
                'WWW-Authenticate': `Basic realm="${String(chatConfig.auth.realm || 'Steam Chat').replace(/"/g, '\\"')}"`,
            });
        },
    });

    async function readRequestBody(req) {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
        });
        await onceFn(req, 'end');
        return body;
    }

    async function readJsonBody(req) {
        const body = await readRequestBody(req);
        if (!body) {
            return {};
        }

        try {
            return JSON.parse(body);
        } catch (err) {
            const error = new Error('Invalid JSON');
            error.code = 400;
            throw error;
        }
    }

    function sendJson(res, statusCode, payload) {
        res.statusCode = statusCode;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(payload));
    }

    function sendAuthRequired(res) {
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', `Basic realm="${String(chatConfig.auth.realm || 'Steam Chat').replace(/"/g, '\\"')}"`);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Authentication Required' }));
    }

    function sendWs(ws, payload) {
        if (ws.readyState === WebSocketImpl.OPEN) {
            ws.send(JSON.stringify(payload));
        }
    }

    function broadcastWs(payload) {
        const encoded = JSON.stringify(payload);
        wss.clients.forEach((ws) => {
            if (ws.readyState === WebSocketImpl.OPEN) {
                ws.send(encoded);
            }
        });
    }

    function appendLogEntry(entry) {
        fsModule.appendFile(CHAT_LOG_FILE, JSON.stringify(entry) + '\n', (err) => {
            if (err) {
                logger.error('an error occurred while writing chat log file: ' + err);
            }
        });
    }

    async function readFileIfExists(filePath) {
        return new Promise((resolve, reject) => {
            fsModule.readFile(filePath, (err, content) => {
                if (err) {
                    if (err.code === 'ENOENT') {
                        resolve(null);
                        return;
                    }
                    reject(err);
                    return;
                }

                resolve(content);
            });
        });
    }

    async function writeFileAsync(filePath, content) {
        return new Promise((resolve, reject) => {
            if (typeof fsModule.writeFile !== 'function') {
                resolve();
                return;
            }

            fsModule.writeFile(filePath, content, (err) => {
                if (err) {
                    reject(err);
                    return;
                }

                resolve();
            });
        });
    }

    async function readJsonIfExists(filePath) {
        const content = await readFileIfExists(filePath);
        if (!content) {
            return null;
        }

        try {
            return JSON.parse(Buffer.isBuffer(content) ? content.toString('utf8') : String(content));
        } catch (err) {
            return null;
        }
    }

    function appendOutgoingLog(uid, response) {
        client.getUserInfo(steamUser.steamID).then((sender) => {
            appendLogEntry({
                type: 'message',
                date: dateToString(response.server_timestamp),
                echo: true,
                id: uid,
                name: sender.player_name,
                message: response.modified_message,
                ordinal: response.ordinal,
            });
        });
    }

    async function appendOutgoingImageLog(uid, imageUrl) {
        const sender = await client.getUserInfo(steamUser.steamID, () => {});
        const entry = {
            type: 'image',
            date: dateToString(new Date()),
            echo: true,
            id: uid,
            name: sender.player_name,
            imageUrl,
            ordinal: null,
            sentAt: new Date().toISOString(),
        };
        appendLogEntry(entry);
        return entry;
    }

    async function encodeSteamMessage(message, echo) {
        let friendId = message.steamid_friend;
        if (typeof friendId !== 'string') {
            friendId = friendId.getSteamID64();
        }

        const friend = await client.getUserInfo(friendId, () => {});

        return {
            type: 'message',
            date: dateToString(message.server_timestamp),
            echo,
            id: friendId,
            name: friend.player_name,
            message: message.message,
            ordinal: message.ordinal,
            imageUrl: null,
            sentAt: null,
        };
    }

    function rememberSelfMessage(message) {
        const key = buildMessageKey(message);
        recentSelfMessages.set(key, Date.now() + 15000);
        const timer = setTimeout(() => {
            recentSelfMessages.delete(key);
        }, 15000);

        if (typeof timer.unref === 'function') {
            timer.unref();
        }
    }

    function wasRecentlyBroadcasted(message) {
        const key = buildMessageKey(message);
        const expiresAt = recentSelfMessages.get(key);
        if (!expiresAt) {
            return false;
        }

        if (expiresAt < Date.now()) {
            recentSelfMessages.delete(key);
            return false;
        }

        return true;
    }

    async function broadcastSteamMessage(message, echo, { dedupe = false } = {}) {
        const data = await encodeSteamMessage(message, echo);
        if (dedupe && wasRecentlyBroadcasted(data)) {
            return;
        }
        if (dedupe && wasRecentImageEcho(data)) {
            return;
        }

        broadcastWs({
            type: 'message',
            data,
        });
    }

    async function getEmoticonList() {
        await ensureWebSession();

        const EMsg = require('steam-user/enums/EMsg');
        const msgKey = EMsg.ClientEmoticonList;

        function removeHandler(handler) {
            const handlers = steamUser._handlerManager._handlers[msgKey];
            if (handlers) {
                const idx = handlers.indexOf(handler);
                if (idx !== -1) {
                    handlers.splice(idx, 1);
                }
            }
        }

        const body = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                removeHandler(handler);
                reject(new Error('getEmoticonList timed out'));
            }, 10000);
            if (typeof timeout.unref === 'function') {
                timeout.unref();
            }
            function handler(body) {
                clearTimeout(timeout);
                removeHandler(handler);
                resolve(body);
            }
            steamUser._handlerManager.add(msgKey, handler);
            steamUser._send(EMsg.ClientGetEmoticonList, {});
        });

        const emoticons = (body.emoticons || []).map((e) => ({
            name: String(e.name || '').replace(/^:+|:+$/g, ''),
            count: e.count,
            use_count: e.use_count || 0,
            time_last_used: e.time_last_used,
            appid: e.appid,
        }));

        const stickers = (body.stickers || []).map((s) => ({
            name: s.name,
            count: s.count,
            use_count: s.use_count || 0,
            time_last_used: s.time_last_used,
            appid: s.appid,
        }));

        return { emoticons, stickers };
    }

    function sendFriendMessage(uid, msg) {
        return new Promise((resolve, reject) => {
            if (!uid || typeof msg !== 'string') {
                reject(new Error('id and msg are required'));
                return;
            }

            steamUser.chat.sendFriendMessage(uid, msg, (err, response) => {
                if (err) {
                    reject(err);
                    return;
                }

                appendOutgoingLog(uid, response);

                resolve({
                    server_timestamp: response.server_timestamp,
                    steamid_friend: uid,
                    message: response.modified_message,
                    ordinal: response.ordinal,
                });
            });
        });
    }

    async function ensureWebSession() {
        await client.steamLoginPromise;
        await client.steamWebLoginPromise;
    }

    function isTransientNetworkError(err) {
        const code = String(err && err.code ? err.code : '').toUpperCase();
        const message = String(err && err.message ? err.message : '').toLowerCase();

        if ([
            'ECONNRESET',
            'ECONNABORTED',
            'ETIMEDOUT',
            'EPIPE',
            'EAI_AGAIN',
            'ENETUNREACH',
            'EHOSTUNREACH',
            'ECONNREFUSED',
        ].includes(code)) {
            return true;
        }

        return message.includes('client network socket disconnected before secure tls connection was established')
            || message.includes('socket disconnected before secure tls connection was established')
            || message.includes('tls connection')
            || message.includes('socket hang up');
    }

    function isLikelyExpiredWebSessionError(err) {
        const code = String(err && err.code ? err.code : '').toUpperCase();
        const message = String(err && err.message ? err.message : '').toLowerCase();

        if (code === 'ESESSIONEXPIRED' || code === 'EWEBSESSION') {
            return true;
        }

        return message.includes('session')
            || message.includes('cookie')
            || message.includes('not logged in')
            || message.includes('access denied')
            || message.includes('forbidden');
    }

    async function waitForFreshWebSession(timeoutMs = 15000) {
        let timer = null;

        try {
            await Promise.race([
                onceFn(steamUser, 'webSession'),
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        const error = new Error(`Timed out after ${timeoutMs}ms while waiting for Steam web session`);
                        error.code = 'WEB_SESSION_TIMEOUT';
                        reject(error);
                    }, timeoutMs);
                }),
            ]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    async function readUrlAsBuffer(url) {
        try {
            const response = await axiosInstance.get(url, { responseType: 'arraybuffer' });
            return Buffer.from(response.data);
        } catch (err) {
            const error = new Error(`Failed to fetch URL: ${err.message}`);
            error.code = 400;
            throw error;
        }
    }

    async function parseImageBuffer({ img, url }) {
        if (url) {
            return readUrlAsBuffer(url);
        }

        if (img) {
            const normalized = String(img).includes(',') ? String(img).split(',').pop() : String(img);
            return Buffer.from(normalized, 'base64');
        }

        const error = new Error('img or url is required');
        error.code = 400;
        throw error;
    }

    function uploadImageToUser(uid, imageBuffer) {
        return new Promise((resolve, reject) => {
            steamCommunity.sendImageToUser(uid, imageBuffer, (err, imageUrl) => {
                if (err) {
                    reject(err);
                    return;
                }

                resolve(imageUrl);
            });
        });
    }

    async function sendImageToUser(uid, img, url) {
        if (!uid) {
            const error = new Error('id is required');
            error.code = 400;
            throw error;
        }

        await ensureWebSession();

        const imageBuffer = await parseImageBuffer({ img, url });

        try {
            return await uploadImageToUser(uid, imageBuffer);
        } catch (err) {
            let uploadError = err;

            if (isTransientNetworkError(uploadError)) {
                logger.warn('temporary network error while sending image, retrying once', {
                    id: uid,
                    error: uploadError.message,
                    code: uploadError.code || null,
                });

                try {
                    return await uploadImageToUser(uid, imageBuffer);
                } catch (retryErr) {
                    uploadError = retryErr;
                }
            }

            if (!isLikelyExpiredWebSessionError(uploadError) && !isTransientNetworkError(uploadError)) {
                logger.error('an error occurred while sending image', uploadError);
                throw uploadError;
            }

            logger.warn('failed to send image, trying to refresh web session', {
                id: uid,
                error: uploadError.message,
                code: uploadError.code || null,
            });

            try {
                steamUser.webLogOn();
                await waitForFreshWebSession();
                return await uploadImageToUser(uid, imageBuffer);
            } catch (retryErr) {
                logger.error('an error occurred while sending image', retryErr);
                throw retryErr;
            }
        }
    }

    function parseLogLines(content) {
        return String(content || '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                try {
                    return normalizeHistoryEntry(JSON.parse(line));
                } catch (err) {
                    logger.warn('skip invalid chat log line', { line });
                    return null;
                }
            })
            .filter(Boolean);
    }

    async function readChatHistory({ id, limit } = {}) {
        const lines = await new Promise((resolve, reject) => {
            fsModule.readFile(CHAT_LOG_FILE, 'utf8', (err, content) => {
                if (err) {
                    if (err.code === 'ENOENT') {
                        resolve('');
                        return;
                    }
                    reject(err);
                    return;
                }

                resolve(content);
            });
        });

        const maxItems = sanitizeLimit(limit, 100);
        let items = parseLogLines(lines);

        if (id) {
            items = items.filter((entry) => entry.id === id);
        }

        if (items.length > maxItems) {
            items = items.slice(-maxItems);
        }

        return sortHistoryItems(items);
    }

    async function readConversationSummaries({ limit } = {}) {
        const items = await readChatHistory({ limit: sanitizeLimit(limit, 500) });
        return buildConversationSummaries(items);
    }

    async function fetchStickerBuffer(type) {
        const normalizedType = String(type || '').trim();
        const cachePath = buildStickerCachePath(normalizedType);
        const cached = await readFileIfExists(cachePath);
        if (cached) {
            return cached;
        }

        const pendingFetch = pendingStickerFetches.get(normalizedType);
        if (pendingFetch) {
            return pendingFetch;
        }

        const urls = buildSteamStickerCandidateUrls(normalizedType);
        let lastError = null;
        const fetchPromise = (async () => {
            for (const url of urls) {
                try {
                    const response = await axiosInstance.get(url, { responseType: 'arraybuffer' });
                    const buffer = Buffer.from(response.data);
                    if (!buffer.length) {
                        continue;
                    }

                    try {
                        await writeFileAsync(cachePath, buffer);
                    } catch (writeErr) {
                        logger.warn('failed to write sticker cache', { type: normalizedType, error: writeErr.message });
                    }

                    return buffer;
                } catch (err) {
                    lastError = err;
                }
            }

            const error = new Error(`Failed to fetch sticker: ${normalizedType}`);
            error.code = 404;
            error.cause = lastError;
            throw error;
        })();

        pendingStickerFetches.set(normalizedType, fetchPromise);

        try {
            return await fetchPromise;
        } finally {
            if (pendingStickerFetches.get(normalizedType) === fetchPromise) {
                pendingStickerFetches.delete(normalizedType);
            }
        }
    }

    async function fetchCachedImage(url) {
        const normalizedUrl = String(url || '').trim();
        if (!/^https?:\/\//i.test(normalizedUrl)) {
            const error = new Error('Invalid image URL');
            error.code = 400;
            throw error;
        }

        const { dataPath, metaPath } = buildImageCachePaths(normalizedUrl);
        const cachedData = await readFileIfExists(dataPath);
        if (cachedData) {
            const cachedMeta = await readJsonIfExists(metaPath);
            return {
                buffer: cachedData,
                contentType: (cachedMeta && cachedMeta.contentType) || guessImageContentType(normalizedUrl),
            };
        }

        const pendingFetch = pendingImageFetches.get(normalizedUrl);
        if (pendingFetch) {
            return pendingFetch;
        }

        const fetchPromise = (async () => {
            const response = await axiosInstance.get(normalizedUrl, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);
            const contentType = guessImageContentType(
                normalizedUrl,
                response.headers && response.headers['content-type'] ? response.headers['content-type'] : 'image/png',
            );

            try {
                await writeFileAsync(dataPath, buffer);
                await writeFileAsync(metaPath, JSON.stringify({ contentType }));
            } catch (err) {
                logger.warn('failed to cache image', { url: normalizedUrl, error: err.message });
            }

            return {
                buffer,
                contentType,
            };
        })();

        pendingImageFetches.set(normalizedUrl, fetchPromise);

        try {
            return await fetchPromise;
        } finally {
            if (pendingImageFetches.get(normalizedUrl) === fetchPromise) {
                pendingImageFetches.delete(normalizedUrl);
            }
        }
    }

    async function handleStickerProxy(req, res, type) {
        try {
            const buffer = await fetchStickerBuffer(type);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Content-Length', buffer.length);
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.end(buffer);
        } catch (err) {
            logger.warn('failed to proxy sticker', { type, error: err.message });
            sendJson(res, err.code || 404, { error: err.message || 'Sticker Not Found' });
        }
    }

    async function handleImageProxy(req, res, url) {
        try {
            const image = await fetchCachedImage(url);
            res.statusCode = 200;
            res.setHeader('Content-Type', image.contentType);
            res.setHeader('Content-Length', image.buffer.length);
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.end(image.buffer);
        } catch (err) {
            logger.warn('failed to proxy image', { url, error: err.message });
            sendJson(res, err.code || 404, { error: err.message || 'Image Not Found' });
        }
    }

    async function handleSendMessageRequest(payload) {
        const message = await sendFriendMessage(payload.id, payload.msg);
        const encoded = await encodeSteamMessage(message, true);
        rememberSelfMessage(encoded);

        broadcastWs({
            type: 'message',
            data: encoded,
        });

        return encoded;
    }

    function rememberSelfImageUrl(uid, imageUrl) {
        const urlKey = `${uid}:${imageUrl}`;
        recentSelfImageUrls.set(urlKey, Date.now() + 15000);

        // Also remember that we sent *any* image to this uid recently,
        // so we can suppress echo messages that contain image URLs even
        // if Steam transforms the URL format.
        const uidKey = `img:${uid}`;
        recentSelfImageUrls.set(uidKey, Date.now() + 15000);

        const timer = setTimeout(() => {
            recentSelfImageUrls.delete(urlKey);
            recentSelfImageUrls.delete(uidKey);
        }, 15000);

        if (typeof timer.unref === 'function') {
            timer.unref();
        }
    }

    function wasRecentImageEcho(data) {
        // Direct match: message text is exactly the remembered image URL
        const directKey = `${data.id}:${data.message}`;
        const directExpiry = recentSelfImageUrls.get(directKey);
        if (directExpiry && directExpiry >= Date.now()) {
            return true;
        }
        if (directExpiry) {
            recentSelfImageUrls.delete(directKey);
        }

        // Extract image URLs from the message and check each one,
        // because Steam may echo the URL wrapped in BBCode like
        // [img src=URL ...]...[/img] or [img]URL[/img].
        const urls = extractImageUrls(data.message);
        for (const url of urls) {
            const key = `${data.id}:${url}`;
            const expiresAt = recentSelfImageUrls.get(key);
            if (!expiresAt) {
                continue;
            }
            if (expiresAt < Date.now()) {
                recentSelfImageUrls.delete(key);
                continue;
            }
            return true;
        }

        // Fallback: if we recently sent any image to this uid and
        // the echo message contains any URL or image BBCode, suppress
        // it even if the exact URL didn't match (Steam may rewrite
        // the URL or use a host without a file extension).
        const messageText = String(data.message || '');
        const looksLikeImageEcho = urls.length > 0
            || /https?:\/\/\S*(?:image|img|ugc|media|cdn)\S*/i.test(messageText)
            || /\[img[\s\]]/i.test(messageText);
        if (looksLikeImageEcho) {
            const uidKey = `img:${data.id}`;
            const uidExpiry = recentSelfImageUrls.get(uidKey);
            if (uidExpiry && uidExpiry >= Date.now()) {
                return true;
            }
            if (uidExpiry) {
                recentSelfImageUrls.delete(uidKey);
            }
        }

        return false;
    }

    async function handleSendImageRequest(payload, { senderWs } = {}) {
        const imageUrl = await sendImageToUser(payload.id, payload.img, payload.url);
        const data = await appendOutgoingImageLog(payload.id, imageUrl);

        // Remember the image URL so the friendMessageEcho (which echoes
        // the image URL as a text message) gets deduplicated.
        rememberSelfImageUrl(payload.id, imageUrl);

        // Broadcast to all clients except the sender (who gets image_sent).
        const encoded = JSON.stringify({ type: 'image', data });
        wss.clients.forEach((ws) => {
            if (ws !== senderWs && ws.readyState === WebSocketImpl.OPEN) {
                ws.send(encoded);
            }
        });

        return data;
    }

    async function handleHttp(req, res) {
        const requestUrl = new URL(req.url, 'http://127.0.0.1');

        if (requiresHttpAuth(req, chatConfig) && !isAuthorized(req, chatConfig.auth)) {
            sendAuthRequired(res);
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/') {
            serveStaticFile(res, 'index.html');
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/api/config') {
            sendJson(res, 200, { wsPath: chatConfig.wsPath });
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/api/emoticons') {
            try {
                const data = await getEmoticonList();
                sendJson(res, 200, data);
            } catch (err) {
                logger.error('failed to get emoticon list', err);
                sendJson(res, err.code || 500, { error: err.message || 'Internal Server Error' });
            }
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname.startsWith('/proxy/sticker/')) {
            const type = decodeURIComponent(requestUrl.pathname.slice('/proxy/sticker/'.length));
            await handleStickerProxy(req, res, type);
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/proxy/image') {
            await handleImageProxy(req, res, requestUrl.searchParams.get('url') || '');
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/history') {
            try {
                const items = await readChatHistory({
                    id: requestUrl.searchParams.get('id') || undefined,
                    limit: requestUrl.searchParams.get('limit') || undefined,
                });
                sendJson(res, 200, { items });
            } catch (err) {
                logger.error('failed to read chat history', err);
                sendJson(res, 500, { error: err.message || 'Internal Server Error' });
            }
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/conversations') {
            try {
                const items = await readConversationSummaries({
                    limit: requestUrl.searchParams.get('limit') || undefined,
                });
                sendJson(res, 200, { items });
            } catch (err) {
                logger.error('failed to read conversations', err);
                sendJson(res, 500, { error: err.message || 'Internal Server Error' });
            }
            return;
        }

        if (req.method === 'GET') {
            const ext = path.extname(requestUrl.pathname);
            if (ext && STATIC_CONTENT_TYPES[ext]) {
                serveStaticFile(res, requestUrl.pathname);
                return;
            }
        }

        if (req.method !== 'POST') {
            sendJson(res, 404, { error: 'Not Found' });
            return;
        }

        try {
            const payload = await readJsonBody(req);

            if (requestUrl.pathname === '/img' || requestUrl.pathname === '/image') {
                const data = await handleSendImageRequest(payload);
                sendJson(res, 200, data);
                return;
            }

            if (requestUrl.pathname === '/' || requestUrl.pathname === '/message') {
                const data = await handleSendMessageRequest(payload);
                sendJson(res, 200, data);
                return;
            }

            sendJson(res, 404, { error: 'Not Found' });
        } catch (err) {
            logger.error('An error occurred while processing the request', err);
            sendJson(res, err.code || 500, { error: err.message || 'Internal Server Error' });
        }
    }

    async function handleWsCommand(ws, payload) {
        const request = normalizeWsRequest(payload);

        switch (request.action) {
            case 'send_message': {
                const data = await handleSendMessageRequest(request);
                sendWs(ws, {
                    type: 'message_sent',
                    requestId: request.requestId,
                    data,
                });
                return;
            }
            case 'send_image': {
                const data = await handleSendImageRequest(request, { senderWs: ws });
                sendWs(ws, {
                    type: 'image_sent',
                    requestId: request.requestId,
                    data,
                });
                return;
            }
            case 'get_history': {
                const items = await readChatHistory({
                    id: request.id,
                    limit: request.limit,
                });
                sendWs(ws, {
                    type: 'history',
                    requestId: request.requestId,
                    data: {
                        items,
                    },
                });
                return;
            }
            case 'get_conversations': {
                const items = await readConversationSummaries({
                    limit: request.limit,
                });
                sendWs(ws, {
                    type: 'conversations',
                    requestId: request.requestId,
                    data: {
                        items,
                    },
                });
                return;
            }
            case 'get_emoticons': {
                const emoticonData = await getEmoticonList();
                sendWs(ws, {
                    type: 'emoticons',
                    requestId: request.requestId,
                    data: emoticonData,
                });
                return;
            }
            case 'ping':
                sendWs(ws, {
                    type: 'pong',
                    requestId: request.requestId,
                    data: {
                        now: new Date().toISOString(),
                    },
                });
                return;
            default: {
                const error = new Error(`Unsupported WebSocket message type: ${payload.type}`);
                error.code = 400;
                throw error;
            }
        }
    }

    function handleWs(ws) {
        logger.info('WebSocket connection established');
        sendWs(ws, {
            type: 'ready',
            data: {
                wsPath: chatConfig.wsPath,
            },
        });

        ws.on('message', async (message) => {
            let payload;
            try {
                payload = JSON.parse(message.toString());
            } catch (err) {
                sendWs(ws, {
                    type: 'error',
                    message: 'Invalid JSON',
                });
                return;
            }

            try {
                await handleWsCommand(ws, payload);
            } catch (err) {
                logger.error('WebSocket command failed', err);
                sendWs(ws, {
                    type: 'error',
                    requestId: payload.requestId,
                    message: err.message || 'Internal Server Error',
                });
            }
        });

        ws.on('close', () => {
            logger.info('WebSocket connection closed');
        });

        ws.on('error', (err) => {
            logger.error('WebSocket error', err);
        });
    }

    async function start() {
        if (started || !chatConfig.enabled) {
            return;
        }
        started = true;

        await client.steamLoginPromise;

        steamUser.chat.on('friendMessage', (message) => {
            broadcastSteamMessage(message, false).catch((err) => {
                logger.error('failed to broadcast friend message', err);
            });
        });

        steamUser.chat.on('friendMessageEcho', (message) => {
            broadcastSteamMessage(message, true, { dedupe: true }).catch((err) => {
                logger.error('failed to broadcast echoed friend message', err);
            });
        });

        wss.on('connection', handleWs);

        await new Promise((resolve, reject) => {
            server.listen(chatConfig.port, chatConfig.host, (err) => {
                if (err) {
                    reject(err);
                    return;
                }

                logger.info('chat server started', {
                    host: chatConfig.host,
                    port: chatConfig.port,
                    wsPath: chatConfig.wsPath,
                });
                resolve();
            });
        });
    }

    return {
        chatConfig,
        server,
        wss,
        start,
        sendFriendMessage,
        sendImageToUser,
        getEmoticonList,
        readChatHistory,
        readConversationSummaries,
        fetchStickerBuffer,
        fetchCachedImage,
        handleSendMessageRequest,
        handleSendImageRequest,
        handleHttp,
        handleWs,
        handleWsCommand,
        broadcastSteamMessage,
        encodeSteamMessage,
        parseImageBuffer,
        parseLogLines,
        readJsonBody,
        wasRecentlyBroadcasted,
        rememberSelfMessage,
        sendWs,
        broadcastWs,
    };
}

let defaultChatService = null;

if (!process.env.STEAM_CHAT_DISABLE_AUTOSTART) {
    defaultChatService = createChatService();
    defaultChatService.start().catch((err) => {
        console.error('Error during chat service initialization', err);
    });
}

module.exports = {
    CHAT_LOG_FILE,
    STICKER_CACHE_DIR,
    IMAGE_CACHE_DIR,
    createChatService,
    normalizeAuthConfig,
    normalizeChatConfig,
    normalizeHistoryEntry,
    normalizeWsRequest,
    normalizeIpAddress,
    parseForwardedHeader,
    getClientIp,
    isLanIp,
    isAuthEnabled,
    parseBasicAuthHeader,
    isAuthorized,
    requiresHttpAuth,
    sanitizeLimit,
    extractStickerType,
    extractEmoticonNames,
    extractImageUrls,
    extractOpenGraphEmbeds,
    buildSteamEmoticonUrl,
    buildSteamStickerCandidateUrls,
    buildStickerCachePath,
    buildImageCachePaths,
    guessImageContentType,
    buildConversationPreview,
    sortHistoryItems,
    buildConversationSummaries,
    buildMessageKey,
    defaultChatService,
};
