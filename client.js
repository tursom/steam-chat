const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const winston = require("winston");
const config = require("./config.js");
const { createSteamLifecycle } = require('./steam-lifecycle');

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

const {
    steamLoginPromise,
    steamWebLoginPromise,
} = createSteamLifecycle({
    steamUser,
    steamCommunity,
    logger,
    config,
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

            if (onUserInfoReceived) {
                onUserInfoReceived(sender);
            }

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
