const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { once } = require('node:events');

process.env.STEAM_CHAT_DISABLE_AUTOSTART = '1';

const {
    CHAT_LOG_FILE,
    IMAGE_CACHE_DIR,
    STICKER_CACHE_DIR,
    buildConversationPreview,
    buildImageCachePaths,
    buildStickerCachePath,
    buildSteamStickerCandidateUrls,
    createChatService,
    extractEmoticonNames,
    extractImageUrls,
    extractOpenGraphEmbeds,
    getClientIp,
    guessImageContentType,
    isLanIp,
    normalizeAuthConfig,
    normalizeChatConfig,
    normalizeHistoryEntry,
    normalizeIpAddress,
    normalizeWsRequest,
    parseBasicAuthHeader,
    parseForwardedHeader,
    requiresHttpAuth,
} = require('../chat');

class FakeWebSocketServer {
    constructor(options) {
        const { server, path } = options;
        this.server = server;
        this.path = path;
        this.options = options;
        this.clients = new Set();
        this.handlers = new Map();
    }

    on(event, handler) {
        this.handlers.set(event, handler);
    }
}

const FakeWebSocket = {
    OPEN: 1,
    Server: FakeWebSocketServer,
};

class FakeSteamUser extends EventEmitter {
    constructor() {
        super();
        this.steamID = 'self-id';
        this.chat = new EventEmitter();
    }

    webLogOn() {}
}

function createMockResponse() {
    return {
        statusCode: 200,
        headers: {},
        body: '',
        writeHead(statusCode, headers) {
            this.statusCode = statusCode;
            if (headers) {
                Object.assign(this.headers, headers);
            }
        },
        setHeader(name, value) {
            this.headers[name] = value;
        },
        end(body) {
            this.body = body;
        },
    };
}

function createMockRequest(method, url, payload) {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = {};
    req.socket = {
        remoteAddress: '127.0.0.1',
    };

    process.nextTick(() => {
        if (payload !== undefined) {
            req.emit('data', Buffer.from(payload));
        }
        req.emit('end');
    });

    return req;
}

function createBroadcastClient() {
    return {
        readyState: FakeWebSocket.OPEN,
        messages: [],
        send(payload) {
            this.messages.push(JSON.parse(payload));
        },
    };
}

function createService(overrides = {}) {
    const logger = {
        info() {},
        warn() {},
        error() {},
    };

    const fsCalls = [];
    let logContent = overrides.logContent || '';
    const extraFiles = new Map(Object.entries(overrides.extraFiles || {}));
    const fsModule = {
        mkdir(_path, _options, cb) {
            cb(null);
        },
        appendFile(path, data, cb) {
            fsCalls.push({ path, data });
            if (path === CHAT_LOG_FILE) {
                logContent += data;
            }
            cb(null);
        },
        readFile(path, encoding, cb) {
            if (typeof encoding === 'function') {
                cb = encoding;
                encoding = undefined;
            }

            if (path === CHAT_LOG_FILE) {
                if (encoding) {
                    assert.equal(encoding, 'utf8');
                }
                cb(null, logContent);
                return;
            }

            if (extraFiles.has(path)) {
                cb(null, extraFiles.get(path));
                return;
            }

            const err = new Error('not found');
            err.code = 'ENOENT';
            cb(err);
        },
        writeFile(path, data, cb) {
            extraFiles.set(path, data);
            cb(null);
        },
    };

    const server = {
        listenArgs: null,
        listen(port, host, cb) {
            this.listenArgs = { port, host };
            cb(null);
        },
    };

    const httpModule = {
        createServer(handler) {
            server.handler = handler;
            return server;
        },
    };

    const steamUser = new FakeSteamUser();
    steamUser.chat.sendFriendMessage = (uid, msg, cb) => {
        cb(null, {
            server_timestamp: new Date('2024-01-02T03:04:05.678Z'),
            modified_message: msg,
            ordinal: 42,
        });
    };

    const steamCommunity = {
        sendImageToUser(uid, imageBuffer, cb) {
            cb(null, `https://image/${uid}/${imageBuffer.length}`);
        },
    };

    const client = {
        steamUser,
        steamCommunity,
        steamLoginPromise: Promise.resolve(),
        steamWebLoginPromise: Promise.resolve(),
        async getUserInfo(steamID) {
            return {
                player_name: steamID === 'self-id' ? 'Self User' : 'Friend User',
            };
        },
    };

    const service = createChatService({
        useDefaultDeps: false,
        rawChatConfig: {
            enabled: true,
            host: '127.0.0.1',
            port: 4000,
            wsPath: '/chat',
        },
        client,
        logger,
        steamUser,
        steamCommunity,
        fsModule,
        httpModule,
        onceFn: once,
        axiosInstance: {
            get: async (url) => ({ data: Buffer.from(String(url).includes('/sticker/') ? 'sticker-image' : 'image-by-url') }),
        },
        WebSocketImpl: FakeWebSocket,
        dateToString: () => 'formatted-date',
        ...overrides,
    });

    return {
        service,
        client,
        steamUser,
        steamCommunity,
        server,
        fsCalls,
    };
}

test('normalizeChatConfig supports boolean and object configs', () => {
    assert.deepEqual(normalizeChatConfig(true), {
        enabled: true,
        host: '0.0.0.0',
        port: 3000,
        wsPath: '/ws',
        auth: {
            username: '',
            password: '',
            realm: 'Steam Chat',
            trustProxy: false,
        },
    });

    assert.deepEqual(normalizeChatConfig({
        enabled: false,
        host: '127.0.0.1',
        port: 8080,
        wsPath: '/chat',
        auth: {
            username: 'alice',
            password: 'secret',
            trustProxy: true,
        },
    }), {
        enabled: false,
        host: '127.0.0.1',
        port: 8080,
        wsPath: '/chat',
        auth: {
            username: 'alice',
            password: 'secret',
            realm: 'Steam Chat',
            trustProxy: true,
        },
    });
});

test('auth and client ip helpers support proxy-aware LAN checks', () => {
    assert.deepEqual(normalizeAuthConfig({
        username: 'alice',
        password: 'secret',
        trustProxy: true,
    }), {
        username: 'alice',
        password: 'secret',
        realm: 'Steam Chat',
        trustProxy: true,
    });

    assert.equal(normalizeIpAddress('::ffff:192.168.1.10'), '192.168.1.10');
    assert.equal(normalizeIpAddress('[2001:db8::1]:443'), '2001:db8::1');
    assert.equal(parseForwardedHeader('for=192.168.1.20;proto=https, for=8.8.8.8'), '192.168.1.20');

    assert.equal(isLanIp('192.168.1.20'), true);
    assert.equal(isLanIp('172.20.1.9'), true);
    assert.equal(isLanIp('8.8.8.8'), false);
    assert.equal(isLanIp('fd00::1234'), true);

    const proxiedReq = {
        headers: {
            'x-forwarded-for': '8.8.8.8, 192.168.1.20',
            authorization: `Basic ${Buffer.from('alice:secret').toString('base64')}`,
        },
        socket: {
            remoteAddress: '127.0.0.1',
        },
    };

    assert.equal(getClientIp(proxiedReq, true), '8.8.8.8');
    assert.deepEqual(parseBasicAuthHeader(proxiedReq.headers.authorization), {
        username: 'alice',
        password: 'secret',
    });
    assert.equal(requiresHttpAuth(proxiedReq, {
        auth: {
            username: 'alice',
            password: 'secret',
            trustProxy: true,
        },
    }), true);
});

test('normalizeWsRequest maps legacy and new websocket message types', () => {
    assert.deepEqual(normalizeWsRequest({
        type: 'msg',
        requestId: '1',
        id: 'friend',
        msg: 'hello',
    }), {
        action: 'send_message',
        requestId: '1',
        id: 'friend',
        msg: 'hello',
    });

    assert.deepEqual(normalizeWsRequest({
        type: 'send_image',
        requestId: '2',
        id: 'friend',
        url: 'https://example.com/a.png',
    }), {
        action: 'send_image',
        requestId: '2',
        id: 'friend',
        img: undefined,
        url: 'https://example.com/a.png',
    });

    assert.deepEqual(normalizeWsRequest({
        type: 'get_history',
        requestId: '3',
        id: 'friend',
        limit: 50,
    }), {
        action: 'get_history',
        requestId: '3',
        id: 'friend',
        limit: 50,
    });

    assert.deepEqual(normalizeWsRequest({
        type: 'get_conversations',
        requestId: '4',
        limit: 20,
    }), {
        action: 'get_conversations',
        requestId: '4',
        limit: 20,
    });
});

test('normalizeHistoryEntry fills defaults for old log format', () => {
    assert.deepEqual(normalizeHistoryEntry({
        date: '2026-03-20 00:00:00.000',
        echo: false,
        id: 'friend',
        name: 'Friend',
        message: 'hello',
        ordinal: 1,
    }), {
        type: 'message',
        date: '2026-03-20 00:00:00.000',
        echo: false,
        id: 'friend',
        name: 'Friend',
        message: 'hello',
        imageUrl: null,
        ordinal: 1,
        sentAt: null,
    });
});

test('extractEmoticonNames parses steam emoticon syntax', () => {
    assert.deepEqual(
        extractEmoticonNames('hi :steamhappy: [emoticon name="cozy"][/emoticon]').sort(),
        ['cozy', 'steamhappy'],
    );

    assert.equal(buildConversationPreview({
        type: 'message',
        message: ':steamhappy: :cozy:',
    }), '[表情] steamhappy cozy');
});

test('extractEmoticonNames parses [emoticon]name[/emoticon] format', () => {
    assert.deepEqual(
        extractEmoticonNames('[emoticon]angrylolo[/emoticon]'),
        ['angrylolo'],
    );

    assert.deepEqual(
        extractEmoticonNames('[emoticon]angrylolo[/emoticon] [emoticon name="cozy"][/emoticon] :steamhappy:').sort(),
        ['angrylolo', 'cozy', 'steamhappy'],
    );

    assert.equal(buildConversationPreview({
        type: 'message',
        message: '[emoticon]angrylolo[/emoticon]',
    }), '[表情] angrylolo');

    assert.equal(buildConversationPreview({
        type: 'message',
        message: '[emoticon]angrylolo[/emoticon][emoticon]steamhappy[/emoticon]',
    }), '[表情] angrylolo steamhappy');
});

test('extractImageUrls parses bbcode img, html img and raw image urls', () => {
    assert.deepEqual(
        extractImageUrls('[img]https://a.com/1.png[/img] <img src="https://b.com/2.jpg"> https://c.com/3.webp').sort(),
        ['https://a.com/1.png', 'https://b.com/2.jpg', 'https://c.com/3.webp'],
    );

    assert.equal(buildConversationPreview({
        type: 'message',
        message: '[img]https://a.com/1.png[/img]',
    }), '[图片]');
});

test('extractOpenGraphEmbeds parses steam og embed and uses title as preview', () => {
    const embeds = extractOpenGraphEmbeds('[og url="https://www.bilibili.com/video/BV1n6A5zAEb7/" img="https://community.steamstatic.com/chat/image/share_image.png" title="伊朗：击中美军F-35战机_哔哩哔哩_bilibili"]https://www.bilibili.com/video/BV1n6A5zAEb7/[/og]');
    assert.deepEqual(embeds, [{
        url: 'https://www.bilibili.com/video/BV1n6A5zAEb7/',
        img: 'https://community.steamstatic.com/chat/image/share_image.png',
        title: '伊朗：击中美军F-35战机_哔哩哔哩_bilibili',
    }]);

    assert.equal(buildConversationPreview({
        type: 'message',
        message: '[og url="https://www.bilibili.com/video/BV1n6A5zAEb7/" img="https://community.steamstatic.com/chat/image/share_image.png" title="伊朗：击中美军F-35战机_哔哩哔哩_bilibili"]https://www.bilibili.com/video/BV1n6A5zAEb7/[/og]',
    }), '伊朗：击中美军F-35战机_哔哩哔哩_bilibili');

    assert.deepEqual(
        extractOpenGraphEmbeds('[og url="https://www.bilibili.com/video/av116186884935795" img="https://community.steamstatic.com/chat/image/ht6wqt0rqW0CLNV0RzFC0nkBpimO7nDqFKftPDtI2M4oDWov4xFO5mWdNM5W1keOmLyp4sg5qbmKqxjRCAFx34WeM5-AxxkNc9h8Kelj5m1raqVeV8436wdU1iQIPxbL_A/share_image.png" title="1899年，吸铁石和生瓜蛋子的时代已然走到尽头_哔哩哔哩_bilibili"]https://www.bilibili.com/video/av116186884935795[/og]'),
        [{
            url: 'https://www.bilibili.com/video/av116186884935795',
            img: 'https://community.steamstatic.com/chat/image/ht6wqt0rqW0CLNV0RzFC0nkBpimO7nDqFKftPDtI2M4oDWov4xFO5mWdNM5W1keOmLyp4sg5qbmKqxjRCAFx34WeM5-AxxkNc9h8Kelj5m1raqVeV8436wdU1iQIPxbL_A/share_image.png',
            title: '1899年，吸铁石和生瓜蛋子的时代已然走到尽头_哔哩哔哩_bilibili',
        }],
    );
});

test('image cache helpers build stable paths and types', () => {
    const paths = buildImageCachePaths('https://example.com/a.png?x=1');
    const normalizedCacheDir = IMAGE_CACHE_DIR.replace(/^\.\//, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(paths.dataPath, new RegExp(`^${normalizedCacheDir}/[a-f0-9]+\\.bin$`));
    assert.match(paths.metaPath, new RegExp(`^${normalizedCacheDir}/[a-f0-9]+\\.json$`));
    assert.equal(guessImageContentType('https://example.com/a.webp'), 'image/webp');
});

test('buildSteamStickerCandidateUrls returns fallback sticker urls', () => {
    assert.deepEqual(buildSteamStickerCandidateUrls('Sticker_MalteseCry'), [
        'https://steamcommunity-a.akamaihd.net/economy/sticker/Sticker_MalteseCry',
        'https://steamcommunity-a.akamaihd.net/economy/stickerlarge/Sticker_MalteseCry',
        'https://steamcommunity.com/economy/sticker/Sticker_MalteseCry',
        'https://steamcommunity.com/economy/stickerlarge/Sticker_MalteseCry',
    ]);
    assert.equal(
        buildStickerCachePath('Sticker_MalteseCry'),
        `${STICKER_CACHE_DIR.replace(/^\.\//, '')}/Sticker_MalteseCry.bin`,
    );
});

test('handleHttp returns config for GET /api/config', async () => {
    const { service } = createService();
    const req = createMockRequest('GET', '/api/config');
    const res = createMockResponse();

    await service.handleHttp(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(res.body), { wsPath: '/chat' });
});

test('handleHttp requires basic auth for non-LAN requests when configured', async () => {
    const { service } = createService({
        rawChatConfig: {
            enabled: true,
            host: '127.0.0.1',
            port: 4000,
            wsPath: '/chat',
            auth: {
                username: 'alice',
                password: 'secret',
                trustProxy: true,
            },
        },
    });

    const req = createMockRequest('GET', '/api/config');
    req.headers['x-forwarded-for'] = '8.8.8.8';
    const res = createMockResponse();

    await service.handleHttp(req, res);

    assert.equal(res.statusCode, 401);
    assert.match(res.headers['WWW-Authenticate'], /^Basic realm="Steam Chat"$/);
    assert.deepEqual(JSON.parse(res.body), { error: 'Authentication Required' });
});

test('handleHttp allows LAN requests and authenticated proxied requests', async () => {
    const rawChatConfig = {
        enabled: true,
        host: '127.0.0.1',
        port: 4000,
        wsPath: '/chat',
        auth: {
            username: 'alice',
            password: 'secret',
            trustProxy: true,
        },
    };

    const { service } = createService({ rawChatConfig });

    const lanReq = createMockRequest('GET', '/api/config');
    lanReq.headers['x-forwarded-for'] = '192.168.1.20';
    const lanRes = createMockResponse();

    await service.handleHttp(lanReq, lanRes);

    assert.equal(lanRes.statusCode, 200);

    const authReq = createMockRequest('GET', '/api/config');
    authReq.headers['x-forwarded-for'] = '8.8.8.8';
    authReq.headers.authorization = `Basic ${Buffer.from('alice:secret').toString('base64')}`;
    const authRes = createMockResponse();

    await service.handleHttp(authReq, authRes);

    assert.equal(authRes.statusCode, 200);
    assert.deepEqual(JSON.parse(authRes.body), { wsPath: '/chat' });
});

test('handleSendMessageRequest broadcasts messages and deduplicates echoed messages', async () => {
    const { service, fsCalls } = createService();
    const wsClient = createBroadcastClient();
    service.wss.clients.add(wsClient);

    const data = await service.handleSendMessageRequest({
        id: 'friend-id',
        msg: 'hello',
    });

    assert.equal(data.echo, true);
    assert.equal(data.name, 'Self User');
    assert.equal(wsClient.messages.length, 1);
    assert.deepEqual(wsClient.messages[0], {
        type: 'message',
        data,
    });
    assert.equal(fsCalls.length, 1);

    await service.broadcastSteamMessage({
        server_timestamp: new Date('2024-01-02T03:04:05.678Z'),
        steamid_friend: 'friend-id',
        message: 'hello',
        ordinal: 42,
    }, true, { dedupe: true });

    assert.equal(wsClient.messages.length, 1);
});

test('sendImageToUser retries after refreshing web session', async () => {
    const expectedBuffer = Buffer.from('fake-image');
    const steamUser = new FakeSteamUser();
    let uploadAttempts = 0;
    let webLogOnCalled = 0;

    steamUser.webLogOn = () => {
        webLogOnCalled += 1;
        setImmediate(() => {
            steamUser.emit('webSession', 'session-id', []);
        });
    };

    const service = createService({
        steamUser,
        steamCommunity: {
            sendImageToUser(_uid, imageBuffer, cb) {
                uploadAttempts += 1;
                assert.deepEqual(imageBuffer, expectedBuffer);
                if (uploadAttempts === 1) {
                    cb(new Error('expired session'));
                    return;
                }
                cb(null, 'https://image/friend-id/retried');
            },
        },
        client: {
            steamUser,
            steamCommunity: null,
            steamLoginPromise: Promise.resolve(),
            steamWebLoginPromise: Promise.resolve(),
            async getUserInfo(steamID) {
                return {
                    player_name: steamID === 'self-id' ? 'Self User' : 'Friend User',
                };
            },
        },
    }).service;

    const imageUrl = await service.sendImageToUser('friend-id', expectedBuffer.toString('base64'));

    assert.equal(imageUrl, 'https://image/friend-id/retried');
    assert.equal(uploadAttempts, 2);
    assert.equal(webLogOnCalled, 1);
});

test('sendImageToUser retries once for transient TLS error before refreshing web session', async () => {
    const expectedBuffer = Buffer.from('fake-image');
    const steamUser = new FakeSteamUser();
    let uploadAttempts = 0;
    let webLogOnCalled = 0;

    steamUser.webLogOn = () => {
        webLogOnCalled += 1;
    };

    const service = createService({
        steamUser,
        steamCommunity: {
            sendImageToUser(_uid, imageBuffer, cb) {
                uploadAttempts += 1;
                assert.deepEqual(imageBuffer, expectedBuffer);
                if (uploadAttempts === 1) {
                    const error = new Error('Client network socket disconnected before secure TLS connection was established');
                    error.code = 'ECONNRESET';
                    cb(error);
                    return;
                }
                cb(null, 'https://image/friend-id/retried');
            },
        },
        client: {
            steamUser,
            steamCommunity: null,
            steamLoginPromise: Promise.resolve(),
            steamWebLoginPromise: Promise.resolve(),
            async getUserInfo(steamID) {
                return {
                    player_name: steamID === 'self-id' ? 'Self User' : 'Friend User',
                };
            },
        },
    }).service;

    const imageUrl = await service.sendImageToUser('friend-id', expectedBuffer.toString('base64'));

    assert.equal(imageUrl, 'https://image/friend-id/retried');
    assert.equal(uploadAttempts, 2);
    assert.equal(webLogOnCalled, 0);
});

test('handleHttp returns JSON response for message endpoint', async () => {
    const { service } = createService();
    const req = createMockRequest('POST', '/message', JSON.stringify({
        id: 'friend-id',
        msg: 'hello via http',
    }));
    const res = createMockResponse();

    await service.handleHttp(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(res.body), {
        type: 'message',
        date: 'formatted-date',
        echo: true,
        id: 'friend-id',
        name: 'Self User',
        message: 'hello via http',
        ordinal: 42,
        imageUrl: null,
        sentAt: null,
    });
});

test('handleWsCommand responds to ping requests', async () => {
    const { service } = createService();
    const ws = createBroadcastClient();

    await service.handleWsCommand(ws, {
        type: 'ping',
        requestId: 'ping-1',
    });

    assert.equal(ws.messages.length, 1);
    assert.equal(ws.messages[0].type, 'pong');
    assert.equal(ws.messages[0].requestId, 'ping-1');
    assert.ok(ws.messages[0].data.now);
});

test('websocket verifyClient requires auth for non-LAN requests', async () => {
    const { service } = createService({
        rawChatConfig: {
            enabled: true,
            host: '127.0.0.1',
            port: 4000,
            wsPath: '/chat',
            auth: {
                username: 'alice',
                password: 'secret',
                trustProxy: true,
            },
        },
    });

    const verifyClient = service.wss.options.verifyClient;

    const denied = await new Promise((resolve) => {
        verifyClient({
            req: {
                headers: {
                    'x-forwarded-for': '8.8.8.8',
                },
                socket: {
                    remoteAddress: '127.0.0.1',
                },
            },
        }, (...args) => resolve(args));
    });

    assert.deepEqual(denied, [
        false,
        401,
        'Authentication Required',
        {
            'WWW-Authenticate': 'Basic realm="Steam Chat"',
        },
    ]);

    const allowed = await new Promise((resolve) => {
        verifyClient({
            req: {
                headers: {
                    'x-forwarded-for': '8.8.8.8',
                    authorization: `Basic ${Buffer.from('alice:secret').toString('base64')}`,
                },
                socket: {
                    remoteAddress: '127.0.0.1',
                },
            },
        }, (...args) => resolve(args));
    });

    assert.deepEqual(allowed, [true]);
});

test('handleHttp serves homepage for GET /', async () => {
    const { service } = createService();
    const req = createMockRequest('GET', '/');
    const res = createMockResponse();

    await service.handleHttp(req, res);

    // serveStaticFile reads the real public/index.html via fs.readFile (async callback),
    // so we need to wait for the callback to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'text/html; charset=utf-8');
    const body = typeof res.body === 'string' ? res.body : res.body.toString();
    assert.match(body, /Steam Chat/);
});

test('handleHttp proxies sticker and caches it locally', async () => {
    const { service } = createService();
    const req = createMockRequest('GET', '/proxy/sticker/Sticker_MalteseCry');
    const res = createMockResponse();

    await service.handleHttp(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'image/png');
    assert.deepEqual(res.body, Buffer.from('sticker-image'));

    const cached = await service.fetchStickerBuffer('Sticker_MalteseCry');
    assert.deepEqual(cached, Buffer.from('sticker-image'));
});

test('fetchStickerBuffer coalesces concurrent requests for the same sticker', async () => {
    let axiosCalls = 0;
    let releaseFetch;
    const fetchGate = new Promise((resolve) => {
        releaseFetch = resolve;
    });

    const { service } = createService({
        axiosInstance: {
            get: async (url) => {
                axiosCalls += 1;
                await fetchGate;
                return {
                    data: Buffer.from('shared-sticker'),
                    headers: {
                        'content-type': 'image/png',
                    },
                };
            },
        },
    });

    const firstFetch = service.fetchStickerBuffer('Sticker_MalteseCry');
    const secondFetch = service.fetchStickerBuffer('Sticker_MalteseCry');

    releaseFetch();

    const [firstSticker, secondSticker] = await Promise.all([firstFetch, secondFetch]);

    assert.equal(axiosCalls, 1);
    assert.deepEqual(firstSticker, Buffer.from('shared-sticker'));
    assert.deepEqual(secondSticker, firstSticker);

    const cached = await service.fetchStickerBuffer('Sticker_MalteseCry');
    assert.equal(axiosCalls, 1);
    assert.deepEqual(cached, firstSticker);
});

test('handleHttp proxies remote image and caches it locally', async () => {
    const { service } = createService();
    const req = createMockRequest('GET', '/proxy/image?url=' + encodeURIComponent('https://example.com/a.png'));
    const res = createMockResponse();

    await service.handleHttp(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'image/png');
    assert.deepEqual(res.body, Buffer.from('image-by-url'));

    const cached = await service.fetchCachedImage('https://example.com/a.png');
    assert.equal(cached.contentType, 'image/png');
    assert.deepEqual(cached.buffer, Buffer.from('image-by-url'));
});

test('fetchCachedImage coalesces concurrent requests for the same image', async () => {
    let axiosCalls = 0;
    let releaseFetch;
    const fetchGate = new Promise((resolve) => {
        releaseFetch = resolve;
    });

    const { service } = createService({
        axiosInstance: {
            get: async (url) => {
                axiosCalls += 1;
                await fetchGate;
                return {
                    data: Buffer.from('shared-image'),
                    headers: {
                        'content-type': 'image/png',
                    },
                };
            },
        },
    });

    const firstFetch = service.fetchCachedImage('https://example.com/shared.png');
    const secondFetch = service.fetchCachedImage('https://example.com/shared.png');

    releaseFetch();

    const [firstImage, secondImage] = await Promise.all([firstFetch, secondFetch]);

    assert.equal(axiosCalls, 1);
    assert.deepEqual(firstImage, {
        buffer: Buffer.from('shared-image'),
        contentType: 'image/png',
    });
    assert.deepEqual(secondImage, firstImage);

    const cached = await service.fetchCachedImage('https://example.com/shared.png');
    assert.equal(axiosCalls, 1);
    assert.deepEqual(cached, firstImage);
});

test('readChatHistory filters by steam id and limits results', async () => {
    const { service } = createService({
        logContent: [
            JSON.stringify({ date: '1', echo: false, id: 'a', name: 'A', message: 'x', ordinal: 1 }),
            JSON.stringify({ type: 'image', date: '2', echo: true, id: 'b', name: 'Self', imageUrl: 'https://img/1' }),
            JSON.stringify({ date: '3', echo: false, id: 'a', name: 'A', message: 'y', ordinal: 2 }),
        ].join('\n') + '\n',
    });

    const items = await service.readChatHistory({ id: 'a', limit: 1 });
    assert.deepEqual(items, [{
        type: 'message',
        date: '3',
        echo: false,
        id: 'a',
        name: 'A',
        message: 'y',
        imageUrl: null,
        ordinal: 2,
        sentAt: null,
    }]);
});

test('handleWsCommand returns history from local logs', async () => {
    const { service } = createService({
        logContent: [
            JSON.stringify({ date: '2026-03-20 10:00:00.000', echo: false, id: 'friend-id', name: 'Friend', message: 'hello', ordinal: 1 }),
            JSON.stringify({ type: 'image', date: '2026-03-20 10:01:00.000', echo: true, id: 'friend-id', name: 'Self User', imageUrl: 'https://image/friend-id/1' }),
        ].join('\n') + '\n',
    });
    const ws = createBroadcastClient();

    await service.handleWsCommand(ws, {
        type: 'get_history',
        requestId: 'history-1',
        id: 'friend-id',
        limit: 10,
    });

    assert.equal(ws.messages.length, 1);
    assert.deepEqual(ws.messages[0], {
        type: 'history',
        requestId: 'history-1',
        data: {
            items: [
                {
                    type: 'message',
                    date: '2026-03-20 10:00:00.000',
                    echo: false,
                    id: 'friend-id',
                    name: 'Friend',
                    message: 'hello',
                    imageUrl: null,
                    ordinal: 1,
                    sentAt: null,
                },
                {
                    type: 'image',
                    date: '2026-03-20 10:01:00.000',
                    echo: true,
                    id: 'friend-id',
                    name: 'Self User',
                    message: '',
                    imageUrl: 'https://image/friend-id/1',
                    ordinal: null,
                    sentAt: null,
                },
            ],
        },
    });
});

test('handleSendImageRequest appends image log and broadcasts image payload', async () => {
    const { service, fsCalls } = createService();
    const wsClient = createBroadcastClient();
    service.wss.clients.add(wsClient);

    const data = await service.handleSendImageRequest({
        id: 'friend-id',
        img: Buffer.from('fake-image').toString('base64'),
    });

    assert.equal(data.type, 'image');
    assert.equal(data.id, 'friend-id');
    assert.equal(data.name, 'Self User');
    assert.equal(data.imageUrl, 'https://image/friend-id/10');
    assert.equal(wsClient.messages.length, 1);
    assert.deepEqual(wsClient.messages[0], {
        type: 'image',
        data,
    });
    assert.equal(fsCalls.length, 1);
    assert.match(fsCalls[0].data, /"type":"image"/);
});

test('readConversationSummaries groups recent conversations', async () => {
    const { service } = createService({
        logContent: [
            JSON.stringify({ date: '2026-03-20 09:00:00.000', echo: false, id: 'a', name: 'Alice', message: '早', ordinal: 1 }),
            JSON.stringify({ date: '2026-03-20 09:10:00.000', echo: true, id: 'b', name: 'Self User', message: 'https://example.com/a.png', ordinal: 1 }),
            JSON.stringify({ date: '2026-03-20 09:20:00.000', echo: false, id: 'a', name: 'Alice', message: '[sticker type="Sticker_MalteseCry" limit="0"][/sticker]', ordinal: 2 }),
        ].join('\n') + '\n',
    });

    const items = await service.readConversationSummaries({ limit: 10 });
    assert.deepEqual(items, [
        {
            id: 'a',
            name: 'Alice',
            updatedAt: '2026-03-20 09:20:00.000',
            preview: '[贴纸] MalteseCry',
            lastType: 'message',
            lastEcho: false,
            messageCount: 2,
        },
        {
            id: 'b',
            name: 'Friend User',
            updatedAt: '2026-03-20 09:10:00.000',
            preview: '[图片]',
            lastType: 'message',
            lastEcho: true,
            messageCount: 1,
        },
    ]);
});

test('handleWsCommand returns conversation summaries', async () => {
    const { service } = createService({
        logContent: [
            JSON.stringify({ date: '2026-03-20 11:00:00.000', echo: false, id: 'friend-1', name: 'Alice', message: 'hello', ordinal: 1 }),
            JSON.stringify({ type: 'image', date: '2026-03-20 11:05:00.000', echo: true, id: 'friend-2', name: 'Self User', imageUrl: 'https://image/friend-2/1' }),
        ].join('\n') + '\n',
    });
    const ws = createBroadcastClient();

    await service.handleWsCommand(ws, {
        type: 'get_conversations',
        requestId: 'conv-1',
        limit: 20,
    });

    assert.equal(ws.messages.length, 1);
    assert.deepEqual(ws.messages[0], {
        type: 'conversations',
        requestId: 'conv-1',
        data: {
            items: [
                {
                    id: 'friend-2',
                    name: 'Friend User',
                    updatedAt: '2026-03-20 11:05:00.000',
                    preview: '[图片]',
                    lastType: 'image',
                    lastEcho: true,
                    messageCount: 1,
                },
                {
                    id: 'friend-1',
                    name: 'Alice',
                    updatedAt: '2026-03-20 11:00:00.000',
                    preview: 'hello',
                    lastType: 'message',
                    lastEcho: false,
                    messageCount: 1,
                },
            ],
        },
    });
});
