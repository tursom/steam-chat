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
        logger.error("An error occurred while creating the logs directory: " + err);
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

    const LogOnOptionsAUTO = {
        logonID: config.logonID,
        refreshToken: refreshToken,
    };
    steamUser.logOn(LogOnOptionsAUTO);
} catch (e) {
    logger.warn(`failed to load session: ${e.message}`)

    steamUser.logOn({
        accountName: config.accountName,
        password: config.password,
        logonID: config.logonID,
    });
}
steamUser.on('loggedOn', () => {
    logger.info(`login to Steam as ${steamUser.steamID}`);

    steamUser.chat.getFriendMessageHistory(
        "76561198453448510",
        {
            maxCount: 10,
        },
        (err, messages) => {
            console.log(typeof messages)
            for (let message of messages.messages) {
                console.log(typeof message.server_timestamp);
                console.log(Object.keys(message.server_timestamp));
            }
            logger.info("chat history", {
                messages: messages,
                err: err,
            });
        });
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

            logger.info("User data received: " + JSON.stringify(sender));
        } catch (err) {
            logger.error("An error occurred while getting user data: ", err);
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
 * @returns {Promise<void>}
 */
async function logMessage(date, steamID, message, echo, ordinal) {
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
            logger.error("An error occurred while writing FullLogs jsonl file: " + e);
        }
    });
}

steamUser.chat.on("friendMessage", (message) => {
    logger.info("friend message", message);

    // noinspection JSIgnoredPromiseFromCall
    logMessage(dateToString(message.server_timestamp), message.steamid_friend, message.message, false);
});

steamUser.chat.on("friendMessageEcho", (message) => {
    logger.info("friend message echo", message);

    // noinspection JSIgnoredPromiseFromCall
    logMessage(dateToString(message.server_timestamp), message.steamid_friend, message.message, true);
});

/**
 * @param {Date} date
 * @returns {string}
 */
function dateToString(date) {
    let milliseconds = date.getMilliseconds().toString().padStart(3, '0');

    return `${date.toLocaleString()}.${milliseconds}`
}
