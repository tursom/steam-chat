const config = require('./config.js');

dateformat = require('@matteo.collina/dateformat');

client = require("./client.js")
steamUser = client.steamUser

fs.mkdir("./logs", {recursive: true}, (err) => {
    if (err) {
        logger.error("an error occurred while creating the logs directory: " + err);
    }
});

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
    return dateformat(date, "yyyy-mm-dd HH:MM:ss.l");
}

/**
 * @param {SteamID} steamID
 * @returns {Promise<{player_name: string}>}
 */
async function getUserInfo(steamID) {
    return client.getUserInfo(steamID, (ignore) => {
        importChatHistory(steamID);
    });
}

function importChatHistory(steamID) {
    if (steamID === steamUser.steamID) {
        return;
    }

    steamUser.chat.getFriendMessageHistory(steamID.getSteamID64(), (err, messages) => {
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

if (config.chat == true) {
    require("./chat.js")
}

module.exports = {
    steamUser: steamUser,
    getUserInfo: getUserInfo,
}
