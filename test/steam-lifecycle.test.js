const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const EResult = require('steam-user/enums/EResult');
const {
    buildLogOnOptions,
    createSteamLifecycle,
    isRecoverableSteamError,
} = require('../steam-lifecycle');

class FakeSteamUser extends EventEmitter {
    constructor() {
        super();
        this.options = { autoRelogin: true };
        this.logOnCalls = [];
        this.webLogOnCalls = 0;
        this.steamID = null;
    }

    setOption(name, value) {
        this.options[name] = value;
    }

    logOn(options) {
        this.logOnCalls.push(options);
    }

    webLogOn() {
        this.webLogOnCalls += 1;
    }
}

function createLogger() {
    const entries = [];
    return {
        entries,
        info(message, meta) {
            entries.push({ level: 'info', message, meta });
        },
        warn(message, meta) {
            entries.push({ level: 'warn', message, meta });
        },
        error(message, meta) {
            entries.push({ level: 'error', message, meta });
        },
    };
}

function createFsModule(token = '') {
    const writes = [];
    return {
        writes,
        readFileSync(path, encoding) {
            assert.equal(path, 'refresh.token');
            assert.equal(encoding, 'utf8');
            if (!token) {
                const err = new Error('missing');
                err.code = 'ENOENT';
                throw err;
            }
            return token;
        },
        writeFileSync(path, data) {
            writes.push({ path, data });
        },
    };
}

function createTimerControls() {
    const timers = [];
    return {
        timers,
        setTimeoutFn(fn, delayMs) {
            const timer = { fn, delayMs, cleared: false };
            timers.push(timer);
            return timer;
        },
        clearTimeoutFn(timer) {
            timer.cleared = true;
        },
        runNextTimer() {
            const timer = timers.find((item) => !item.cleared && !item.ran);
            assert.ok(timer, 'expected a pending timer');
            timer.ran = true;
            timer.fn();
            return timer;
        },
    };
}

function createLifecycle(overrides = {}) {
    const steamUser = overrides.steamUser || new FakeSteamUser();
    const steamCommunity = overrides.steamCommunity || {
        cookies: [],
        checkerCalls: [],
        setCookies(cookies) {
            this.cookies.push(cookies);
        },
        startConfirmationChecker(intervalMs, identitySecret) {
            this.checkerCalls.push({ intervalMs, identitySecret });
        },
    };
    const logger = overrides.logger || createLogger();
    const fsModule = overrides.fsModule || createFsModule(overrides.refreshToken);
    const timerControls = overrides.timerControls || createTimerControls();
    const config = {
        accountName: 'account',
        password: 'password',
        logonID: 123,
        steamID: 'self-id',
        identitySecret: 'identity-secret',
        ...overrides.config,
    };

    const lifecycle = createSteamLifecycle({
        steamUser,
        steamCommunity,
        logger,
        config,
        fsModule,
        setTimeoutFn: timerControls.setTimeoutFn,
        clearTimeoutFn: timerControls.clearTimeoutFn,
        initialRetryDelayMs: 10,
        maxRetryDelayMs: 40,
    });

    return {
        lifecycle,
        steamUser,
        steamCommunity,
        logger,
        fsModule,
        timerControls,
    };
}

test('buildLogOnOptions uses refresh token when available', () => {
    const fsModule = createFsModule(' token-value \n');

    assert.deepEqual(buildLogOnOptions({
        accountName: 'account',
        password: 'password',
        logonID: 7,
        steamID: 'self-id',
    }, fsModule), {
        mode: 'refreshToken',
        options: {
            logonID: 7,
            refreshToken: 'token-value',
            steamID: 'self-id',
        },
    });
});

test('buildLogOnOptions falls back to credentials without a refresh token', () => {
    const fsModule = createFsModule('');

    assert.deepEqual(buildLogOnOptions({
        accountName: 'account',
        password: 'password',
        logonID: 7,
        steamID: 'self-id',
    }, fsModule), {
        mode: 'credentials',
        options: {
            accountName: 'account',
            password: 'password',
            logonID: 7,
            steamID: 'self-id',
        },
    });
});

test('steam disconnected logs warning and lets steam-user autoRelogin handle reconnect', () => {
    const { steamUser, logger } = createLifecycle();

    assert.equal(steamUser.logOnCalls.length, 1);

    steamUser.emit('disconnected', EResult.NoConnection, 'connection closed');

    assert.equal(steamUser.logOnCalls.length, 1);
    assert.deepEqual(logger.entries.find((entry) => entry.message === 'steam disconnected'), {
        level: 'warn',
        message: 'steam disconnected',
        meta: {
            eresult: EResult.NoConnection,
            eresultName: 'NoConnection',
            message: 'connection closed',
            autoRelogin: true,
        },
    });
});

test('recoverable steam errors schedule a single retry and re-log on', () => {
    const { steamUser, logger, timerControls } = createLifecycle({
        refreshToken: 'refresh-token',
    });

    const err = new Error('No Steam servers available');
    err.eresult = EResult.NoConnection;

    steamUser.emit('error', err);
    steamUser.emit('error', err);

    assert.equal(timerControls.timers.length, 1);
    assert.equal(timerControls.timers[0].delayMs, 10);
    assert.equal(steamUser.logOnCalls.length, 1);
    assert.equal(logger.entries.filter((entry) => entry.message === 'steam reconnect scheduled').length, 1);
    assert.equal(logger.entries.filter((entry) => entry.message === 'steam reconnect already scheduled').length, 1);

    timerControls.runNextTimer();

    assert.equal(steamUser.logOnCalls.length, 2);
    assert.deepEqual(steamUser.logOnCalls[1], {
        logonID: 123,
        refreshToken: 'refresh-token',
        steamID: 'self-id',
    });
});

test('non-recoverable initial steam errors reject login and do not retry', async () => {
    const { lifecycle, steamUser, timerControls } = createLifecycle();
    const err = new Error('InvalidPassword');
    err.eresult = EResult.InvalidPassword;

    steamUser.emit('error', err);

    await assert.rejects(lifecycle.steamLoginPromise, err);
    assert.equal(timerControls.timers.length, 0);
});

test('loggedOn clears pending retry, resets backoff, resolves login, and starts web login', async () => {
    const { lifecycle, steamUser, timerControls } = createLifecycle({
        refreshToken: 'refresh-token',
    });
    const err = new Error('timeout');
    err.eresult = EResult.Timeout;

    steamUser.emit('error', err);
    assert.equal(timerControls.timers.length, 1);

    steamUser.steamID = 'self-id';
    steamUser.emit('loggedOn');
    await lifecycle.steamLoginPromise;

    assert.equal(timerControls.timers[0].cleared, true);
    assert.equal(steamUser.webLogOnCalls, 1);

    steamUser.emit('error', err);
    assert.equal(timerControls.timers.length, 2);
    assert.equal(timerControls.timers[1].delayMs, 10);
});

test('webSession refreshes cookies repeatedly but starts confirmation checker once', async () => {
    const { lifecycle, steamUser, steamCommunity } = createLifecycle();

    steamUser.emit('webSession', 'session-1', ['cookie-1']);
    steamUser.emit('webSession', 'session-2', ['cookie-2']);

    await lifecycle.steamWebLoginPromise;
    assert.deepEqual(steamCommunity.cookies, [['cookie-1'], ['cookie-2']]);
    assert.deepEqual(steamCommunity.checkerCalls, [{
        intervalMs: 10000,
        identitySecret: 'identity-secret',
    }]);
});

test('refreshToken writes token and logs write failures without creating connection log files', () => {
    const fsModule = createFsModule();
    const logger = createLogger();
    const { steamUser } = createLifecycle({ fsModule, logger });

    steamUser.emit('refreshToken', 'new-token');

    assert.deepEqual(fsModule.writes, [{
        path: 'refresh.token',
        data: 'new-token',
    }]);

    const failingFsModule = {
        readFileSync() {
            const err = new Error('missing');
            err.code = 'ENOENT';
            throw err;
        },
        writeFileSync() {
            throw new Error('disk full');
        },
    };
    const failingLogger = createLogger();
    const { steamUser: failingSteamUser } = createLifecycle({
        fsModule: failingFsModule,
        logger: failingLogger,
    });

    failingSteamUser.emit('refreshToken', 'new-token');

    assert.equal(
        failingLogger.entries.some((entry) => entry.message === 'failed to write steam refresh token'),
        true
    );
});

test('isRecoverableSteamError classifies expected recoverable and fatal errors', () => {
    const networkErr = new Error('socket disconnected before secure TLS connection was established');
    networkErr.eresult = EResult.Fail;
    assert.equal(isRecoverableSteamError(networkErr), true);

    const authErr = new Error('InvalidPassword');
    authErr.eresult = EResult.InvalidPassword;
    assert.equal(isRecoverableSteamError(authErr), false);

    const replacedSessionErr = new Error('LoggedInElsewhere');
    replacedSessionErr.eresult = EResult.LoggedInElsewhere;
    assert.equal(isRecoverableSteamError(replacedSessionErr), false);

    const throttledErr = new Error('AccountLoginDeniedThrottle');
    throttledErr.eresult = EResult.AccountLoginDeniedThrottle;
    assert.equal(isRecoverableSteamError(throttledErr), false);
});
