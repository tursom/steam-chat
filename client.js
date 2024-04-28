SteamID = require('steamid');
SteamUser = require('steam-user');
SteamTotp = require('steam-totp');
fs = require('fs');
winston = require("winston");

logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    defaultMeta: {service: 'steam-logger'},
    transports: [
        new winston.transports.Console(),
    ]
});

const users = {};

const steamUser = new SteamUser();

steamUser.setOption("renewRefreshTokens", true);
steamUser.on("refreshToken", (refreshToken) => {
    logger.info("Refresh token: " + refreshToken);
    fs.writeFileSync('refresh.token', refreshToken);
});

config = require("./config.js");

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
steamUser.on('loggedOn', () => {
    logger.info(`login to Steam as ${steamUser.steamID}`);
});

async function getUserInfo(steamID, onUserInfoReceived) {
    let sender = users[steamID.getSteamID64()];
    // if user is not cached
    if (!sender) {
        try {
            let personasResult = await steamUser.getPersonas([steamID]);
            users[steamID.getSteamID64()] = personasResult.personas[steamID.getSteamID64()];
            sender = users[steamID.getSteamID64()];

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
    steamUser: steamUser,
    getUserInfo: getUserInfo,
}

