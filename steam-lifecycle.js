const fs = require('fs');
const EResult = require('steam-user/enums/EResult');

const DEFAULT_INITIAL_RETRY_DELAY_MS = 5000;
const DEFAULT_MAX_RETRY_DELAY_MS = 5 * 60 * 1000;

const RECOVERABLE_ERESULTS = new Set([
    EResult.Invalid,
    EResult.Fail,
    EResult.NoConnection,
    EResult.Busy,
    EResult.Timeout,
    EResult.ServiceUnavailable,
    EResult.TryAnotherCM,
]);

const NON_RECOVERABLE_ERESULTS = new Set([
    EResult.InvalidPassword,
    EResult.LoggedInElsewhere,
    EResult.Banned,
    EResult.AccountNotFound,
    EResult.InvalidSteamID,
    EResult.AccountDisabled,
    EResult.AlreadyLoggedInElsewhere,
    EResult.Suspended,
    EResult.PasswordUnset,
    EResult.IllegalPassword,
    EResult.AccountLogonDenied,
    EResult.InvalidLoginAuthCode,
    EResult.AccountLogonDeniedNoMail,
    EResult.ExpiredLoginAuthCode,
    EResult.IPLoginRestrictionFailed,
    EResult.AccountLockedDown,
    EResult.AccountLogonDeniedVerifiedEmailRequired,
    EResult.RequirePasswordReEntry,
    EResult.RateLimitExceeded,
    EResult.AccountLoginDeniedNeedTwoFactor,
    EResult.AccountLoginDeniedThrottle,
    EResult.TwoFactorCodeMismatch,
    EResult.TimeNotSynced,
    EResult.NeedCaptcha,
    EResult.IPBanned,
    EResult.LimitedUserAccount,
].filter((value) => typeof value === 'number'));

const NON_RECOVERABLE_MESSAGE_PATTERNS = [
    /invalid password/i,
    /invalid refresh token/i,
    /refreshToken is not/i,
    /not valid for logging in/i,
    /does not match refreshToken/i,
    /steam guard/i,
    /two[- ]?factor/i,
    /account login denied/i,
    /logged in elsewhere/i,
];

const RECOVERABLE_MESSAGE_PATTERNS = [
    /no steam servers available/i,
    /no connection/i,
    /service unavailable/i,
    /try another cm/i,
    /timeout/i,
    /timed out/i,
    /econnreset/i,
    /econnrefused/i,
    /enotfound/i,
    /eai_again/i,
    /socket/i,
    /tls/i,
    /network/i,
    /rate limit/i,
];

function getEResultName(eresult) {
    if (eresult === undefined || eresult === null) {
        return undefined;
    }

    return EResult[eresult] || String(eresult);
}

function buildLogOnOptions(config, fsModule = fs, refreshTokenPath = 'refresh.token') {
    try {
        const refreshToken = fsModule.readFileSync(refreshTokenPath, 'utf8').trim();

        if (refreshToken.length > 0) {
            return {
                options: {
                    logonID: config.logonID,
                    refreshToken,
                    steamID: config.steamID,
                },
                mode: 'refreshToken',
            };
        }
    } catch (err) {
        // Missing or unreadable refresh tokens are expected on first start.
    }

    return {
        options: {
            accountName: config.accountName,
            password: config.password,
            logonID: config.logonID,
            steamID: config.steamID,
        },
        mode: 'credentials',
    };
}

function isRecoverableSteamError(err) {
    if (!err) {
        return true;
    }

    const message = String(err.message || err);
    if (NON_RECOVERABLE_ERESULTS.has(err.eresult)) {
        return false;
    }

    if (NON_RECOVERABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))) {
        return false;
    }

    if (RECOVERABLE_ERESULTS.has(err.eresult)) {
        return true;
    }

    if (RECOVERABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))) {
        return true;
    }

    return false;
}

function createSteamLifecycle({
    steamUser,
    steamCommunity,
    logger,
    config,
    fsModule = fs,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    refreshTokenPath = 'refresh.token',
    initialRetryDelayMs = DEFAULT_INITIAL_RETRY_DELAY_MS,
    maxRetryDelayMs = DEFAULT_MAX_RETRY_DELAY_MS,
}) {
    let loginResolved = false;
    let loginRejected = false;
    let retryDelayMs = initialRetryDelayMs;
    let retryTimer = null;
    let confirmationCheckerStarted = false;

    let resolveLogin;
    let rejectLogin;
    const steamLoginPromise = new Promise((resolve, reject) => {
        resolveLogin = resolve;
        rejectLogin = reject;
    });

    let resolveWebLogin;
    const steamWebLoginPromise = new Promise((resolve) => {
        resolveWebLogin = resolve;
    });

    function clearRetryTimer() {
        if (retryTimer) {
            clearTimeoutFn(retryTimer);
            retryTimer = null;
        }
    }

    function logOn(reason) {
        const { options, mode } = buildLogOnOptions(config, fsModule, refreshTokenPath);

        logger.info('steam logon started', {
            reason,
            mode,
            steamID: config.steamID,
        });

        steamUser.logOn(options);
    }

    function scheduleRetry(err) {
        if (retryTimer) {
            logger.warn('steam reconnect already scheduled', {
                delayMs: retryDelayMs,
                error: err && err.message,
                eresult: err && err.eresult,
                eresultName: err && getEResultName(err.eresult),
            });
            return;
        }

        const delayMs = retryDelayMs;
        logger.warn('steam reconnect scheduled', {
            delayMs,
            error: err && err.message,
            eresult: err && err.eresult,
            eresultName: err && getEResultName(err.eresult),
        });

        retryTimer = setTimeoutFn(() => {
            retryTimer = null;
            retryDelayMs = Math.min(retryDelayMs * 2, maxRetryDelayMs);

            try {
                logOn('retry');
            } catch (retryErr) {
                logger.error('steam reconnect attempt failed to start', {
                    error: retryErr.message,
                });
                scheduleRetry(retryErr);
            }
        }, delayMs);
    }

    steamUser.setOption('renewRefreshTokens', true);

    steamUser.on('refreshToken', (refreshToken) => {
        logger.info('steam refresh token received');

        try {
            fsModule.writeFileSync(refreshTokenPath, refreshToken);
        } catch (err) {
            logger.error('failed to write steam refresh token', {
                error: err.message,
            });
        }
    });

    steamUser.on('loggedOn', () => {
        clearRetryTimer();
        retryDelayMs = initialRetryDelayMs;
        loginResolved = true;

        logger.info(`login to Steam as ${steamUser.steamID}`);

        try {
            steamUser.webLogOn();
        } catch (err) {
            logger.warn(`failed to start web login: ${err.message}`);
        }

        resolveLogin();
    });

    steamUser.on('disconnected', (eresult, msg) => {
        logger.warn('steam disconnected', {
            eresult,
            eresultName: getEResultName(eresult),
            message: msg,
            autoRelogin: steamUser.options && steamUser.options.autoRelogin,
        });
    });

    steamUser.on('error', (err) => {
        const recoverable = isRecoverableSteamError(err);

        logger.error('steam error', {
            error: err && err.message,
            eresult: err && err.eresult,
            eresultName: err && getEResultName(err.eresult),
            recoverable,
        });

        if (recoverable) {
            scheduleRetry(err);
            return;
        }

        clearRetryTimer();

        if (!loginResolved && !loginRejected) {
            loginRejected = true;
            rejectLogin(err);
        }
    });

    steamUser.on('webSession', (sessionID, cookies) => {
        logger.info(`web session received: ${sessionID}`);

        steamCommunity.setCookies(cookies);
        if (config.identitySecret && !confirmationCheckerStarted) {
            try {
                steamCommunity.startConfirmationChecker(10000, config.identitySecret);
                confirmationCheckerStarted = true;
            } catch (err) {
                logger.warn('failed to start confirmation checker', {
                    error: err.message,
                });
            }
        }

        resolveWebLogin();
    });

    logOn('initial');

    return {
        steamLoginPromise,
        steamWebLoginPromise,
        isRecoverableSteamError,
        buildLogOnOptions,
        getEResultName,
    };
}

module.exports = {
    DEFAULT_INITIAL_RETRY_DELAY_MS,
    DEFAULT_MAX_RETRY_DELAY_MS,
    buildLogOnOptions,
    createSteamLifecycle,
    getEResultName,
    isRecoverableSteamError,
};
