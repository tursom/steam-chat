const SteamID = require('steamid');
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const SteamCommunity = require('steamcommunity');
const fs = require('fs');
const winston = require("winston");

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    defaultMeta: { service: 'steam-logger' },
    transports: [
        new winston.transports.Console(),
    ]
});

const users = {};

const steamUser = new SteamUser();
const steamCommunity = new SteamCommunity();

steamUser.setOption("renewRefreshTokens", true);
steamUser.on("refreshToken", (refreshToken) => {
    logger.info("Refresh token: " + refreshToken);
    fs.writeFileSync('refresh.token', refreshToken);
});

const config = require("./config.js");

try {
    refreshToken = fs.readFileSync('refresh.token', 'utf8');

    if (refreshToken && refreshToken.length > 0) {
        const LogOnOptionsAUTO = {
            logonID: config.logonID,
            refreshToken: refreshToken,
            steamID: config.steamID,
        };
        steamUser.logOn(LogOnOptionsAUTO);
    } else {
        steamUser.logOn({
            accountName: config.accountName,
            password: config.password,
            logonID: config.logonID,
            steamID: config.steamID,
        });
    }
} catch (e) {
    logger.warn(`failed to load session: ${e.message}`)

    steamUser.logOn({
        accountName: config.accountName,
        password: config.password,
        logonID: config.logonID,
        steamID: config.steamID,
    });
}

steamLoginPromise = new Promise((resolve, reject) => {
    steamUser.on('loggedOn', async () => {
        logger.info(`login to Steam as ${steamUser.steamID}`);

        resolve();
    });
});

steamWebLoginPromise = new Promise((resolve, reject) => {
    steamUser.on('webSession', async (sessionID, cookies) => {
        logger.info(`web session received: ${sessionID}`);

        webLogOn = true;
        steamCommunity.setCookies(cookies);
        steamCommunity.startConfirmationChecker(10000, config.identitySecret);

        resolve()
    });
});

async function getUserInfo(steamID, onUserInfoReceived) {
    if (typeof steamID !== 'string') {
        steamID = steamID.getSteamID64();
    }
    let sender = users[steamID];
    // if user is not cached
    if (!sender) {
        try {
            let personasResult = await steamUser.getPersonas([steamID]);
            users[steamID] = personasResult.personas[steamID];
            sender = users[steamID];

            onUserInfoReceived(sender);

            // noinspection ES6MissingAwait
            logger.info("user data received: " + JSON.stringify(sender));
        } catch (err) {
            logger.error("an error occurred while getting user data: ", err);
            sender = {
                player_name: "Unknown",
            };
        }
    }
    return sender;
}

module.exports = {
    logger: logger,
    steamUser: steamUser,
    steamCommunity: steamCommunity,
    getUserInfo: getUserInfo,
    steamLoginPromise: steamLoginPromise,
    steamWebLoginPromise: steamWebLoginPromise,
}

