const client = require("./client")
const axios = require('axios');
const http = require('http');
const fs = require('fs');
const { once } = require("node:events");
const dateformat = require('@matteo.collina/dateformat');
const WebSocket = require('ws');

const logger = client.logger
const steamUser = client.steamUser

fs.mkdir("./logs", { recursive: true }, (err) => {
    if (err) {
        logger.error("an error occurred while creating the logs directory: " + err);
    }
});

async function sendMsg(req, res) {
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString(); // 将Buffer转换为字符串
    });

    await once(req, 'end');

    let requests = JSON.parse(body);

    console.log(requests)

    try {
        await sendFriendMessage(requests.id, requests.msg);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain');
        res.end('Success\n');
    } catch (err) {
        logger.error("failed to send friend message", err);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain');
        res.end('Internal Server Error\n');
    }
}

function sendFriendMessage(uid, msg) {
    return new Promise((resolve, reject) => {
        client.steamUser.chat.sendFriendMessage(uid, msg, (err, response) => {
            if (err) {
                resolve(err);
                return
            }

            client.getUserInfo(client.steamUser.steamID).then((sender) => {
                fs.appendFile("./logs/chat.jsonl", JSON.stringify({
                    date: dateToString(response.server_timestamp),
                    echo: true,
                    id: uid,
                    name: sender.player_name,
                    message: response.modified_message,
                    ordinal: response.ordinal,
                }) + "\n", (e) => {
                    if (e) {
                        logger.error("an error occurred while writing chat log file: " + e);
                    }
                });
            })

            onSteamMessage({
                server_timestamp: response.server_timestamp,
                steamid_friend: uid,
                message: response.modified_message,
                ordinal: response.ordinal,
            }, true);

            resolve();
        })
    });
}

function logSendMsg(uid, response) {
    client.getUserInfo(client.steamUser.steamID).then((sender) => {
        fs.appendFile("./logs/chat.jsonl", JSON.stringify({
            date: dateToString(response.server_timestamp),
            echo: true,
            id: uid,
            name: sender.player_name,
            message: response.modified_message,
            ordinal: response.ordinal,
        }) + "\n", (e) => {
            if (e) {
                logger.error("an error occurred while writing chat log file: " + e);
            }
        });
    })
}

async function sendImg(req, res) {
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString(); // 将Buffer转换为字符串
    });

    await once(req, 'end');

    let requests = JSON.parse(body);

    res.setHeader('Content-Type', 'text/plain');
    let err = await sendImageToUser(requests.id, requests.img, requests.url);
    if (err) {
        const { code = 500, message = "Internal Server Error" } = err;
        res.statusCode = code;
        res.end(message + '\n');
        return
    }
    res.statusCode = 200;
    res.end('Success\n');
}

function sendImageToUser(uid, img, url) {
    return new Promise(async (resolve, reject) => {
        if (img) {
            console.log({
                uid: uid,
                img: img.length,
            });
        } else {
            console.log({
                uid: uid,
                url: url,
            });
        }

        if (url) {
            img = await readUrlAsBuffer(url)
        } else if (img) {
            img = Buffer.from(img, 'base64');
        } else {
            resolve({ code: 400, message: "Bad Request" });
            return;
        }

        client.steamCommunity.sendImageToUser(uid, img, function (err, imageUrl) {
            if (err) {
                logger.error("an error occurred while sending image: ", err);
                client.steamUser.webLogOn();
                resolve({});
                return
            }

            resolve();
        });
    })
}

async function readUrlAsBuffer(url) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return Buffer.from(response.data);
    } catch (err) {
        throw new Error(`Failed to fetch URL: ${err.message}`);
    }
}

function readFileAsBuffer(filePath) {
    return new Promise((resolve, reject) => {
        fs.readFile(filePath, (err, data) => {
            if (err) {
                return reject(err);
            }
            resolve(data);
        });
    });
}

function dateToString(date) {
    return dateformat(date, "yyyy-mm-dd HH:MM:ss.l");
}

async function handleHttp(req, res) {
    try {
        if (req.url == "/img") {
            await sendImg(req, res);
        } else {
            await sendMsg(req, res);
        }
    } catch (e) {
        console.error("An error occurred while processing the request: ", e);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain');
        res.end('Internal Server Error\n');
    }
}

function handleWs(ws) {
    console.log('WebSocket connection established.');

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch {
            ws.close(1003, 'Invalid JSON');
            return;
        }
        logger.info('Received message:', data);

        switch (data.type) {
            case "msg":
                sendFriendMessage(data.id, data.msg);
                break;
            case "img":
                sendImageToUser(data.id, data.img, data.url);
                break
        }
    });

    ws.on('close', () => {
        logger.info('WebSocket connection closed.');
    });

    ws.on('error', (err) => {
        logger.error('WebSocket error:', err);
    });
}

async function messageToJson(message, echo) {
    let friendId = message.steamid_friend
    if (typeof friendId !== 'string') {
        friendId = friendId.getSteamID64();
    }

    let sender = await client.getUserInfo(echo ? steamUser.steamID : friendId, (ignore) => { });

    return JSON.stringify({
        date: dateToString(message.server_timestamp),
        echo: echo,
        id: friendId,
        name: sender.player_name,
        message: message.message,
        ordinal: message.ordinal,
    })
}

async function onSteamMessage(message, echo) {
    let messageEncoded = await messageToJson(message, echo);

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(messageEncoded);
        }
    });
}

client.steamLoginPromise.then(() => {
    steamUser.chat.on("friendMessage", (message) => {
        // noinspection JSIgnoredPromiseFromCall
        onSteamMessage(message, false);
    });

    steamUser.chat.on("friendMessageEcho", (message) => {
        // noinspection JSIgnoredPromiseFromCall
        onSteamMessage(message, true);
    });

    try {
        const server = http.createServer(handleHttp);

        // 创建 WebSocket 服务器，并限制路径为 /ws
        globalThis.wss = new WebSocket.Server({ server, path: '/ws' });

        wss.on('connection', handleWs);

        server.listen(3000, '0.0.0.0', () => {
            console.log('Server running at http://0.0.0.0:3000/');
            console.log('WebSocket server is also running.');
        });
    } catch (err) {
        console.error('Error during initialization:', err);
    }
});
