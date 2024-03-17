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

fs.mkdir("./logs", {recursive: true}, (err) => {
    if (err) {
        logger.error("an error occurred while creating the logs directory: " + err);
    }
});

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

/**
 * @param {SteamID} steamID
 * @returns {Promise<{player_name: string}>}
 */
async function getUserInfo(steamID) {
    let sender = users[steamID.getSteamID64()];
    // if user is not cached
    if (!sender) {
        try {
            let personasResult = await steamUser.getPersonas([steamID]);
            users[steamID.getSteamID64()] = personasResult.personas[steamID.getSteamID64()];
            sender = users[steamID.getSteamID64()];

            importChatHistory(steamID);

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

/**
 * @param {string} date
 * @param {SteamID} steamID
 * @param {string} message
 * @param {boolean} echo
 * @param {number} ordinal
 * @returns {Promise<void>}
 */
async function logMessage(date, steamID, message, echo, ordinal) {
    // try to get chat history
    await getUserInfo(steamID);

    let sender = await getUserInfo(echo ? steamUser.steamID : steamID);
    logger.info("log steam chat message", {
        echo: echo,
        id: steamID.getSteamID64(),
        name: sender.player_name,
        message: message,
        ordinal: ordinal,
    });
    fs.appendFile("./logs/chat.jsonl", JSON.stringify({
        date: date,
        echo: echo,
        id: steamID.getSteamID64(),
        name: sender.player_name,
        message: message,
        ordinal: ordinal,
    }) + "\n", (e) => {
        if (e) {
            logger.error("an error occurred while writing chat log file: " + e);
        }
    });
}

steamUser.chat.on("friendMessage", (message) => {
    // noinspection JSIgnoredPromiseFromCall
    logMessage(dateToString(message.server_timestamp), message.steamid_friend, message.message, false, message.ordinal);
});

steamUser.chat.on("friendMessageEcho", (message) => {
    // noinspection JSIgnoredPromiseFromCall
    logMessage(dateToString(message.server_timestamp), message.steamid_friend, message.message, true, message.ordinal);
});

/**
 * @param {Date} date
 * @returns {string}
 */
function dateToString(date) {
    let milliseconds = date.getMilliseconds().toString().padStart(3, '0');

    return `${date.toLocaleString()}.${milliseconds}`
}

function importChatHistory(steamID) {
    if (steamID === steamUser.steamID) {
        return;
    }

    steamUser.chat.getFriendMessageHistory(steamID.getSteamID64(), {
        maxCount: 5
    }, (err, messages) => {
        if (err) {
            logger.error("an error occurred while getting chat history: ", err);
            return
        }

        for (let message of messages.messages) {
            logger.info("get chat history", message);
            logMessage(
                dateToString(message.server_timestamp),
                steamID, message.message,
                message.sender.getSteamID64() === steamUser.steamID.getSteamID64(),
                message.ordinal,
            );
        }
    });
}

module.exports = {
    steamUser: steamUser,
    getUserInfo: getUserInfo,
}
