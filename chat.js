const client = require("./client")
const axios = require('axios');
const http = require('http');
const { once } = require("node:events");

async function sendMsg(req, res) {
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString(); // 将Buffer转换为字符串
    });

    await once(req, 'end');

    let requests = JSON.parse(body);

    console.log(requests)

    client.steamUser.chat.sendFriendMessage(requests.id, requests.msg, (err, response) => {
        if (err) {
            console.log(err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/plain');
            res.end('Internal Server Error\n');
            return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain');
        res.end('Success\n');
    })
}

async function sendImg(req, res) {
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString(); // 将Buffer转换为字符串
    });

    await once(req, 'end');

    let requests = JSON.parse(body);

    console.log(requests)

    if (requests.url) {
        img = await readUrlAsBuffer(requests.url)
    } else if (requests.img) {
        img = Buffer.from(requests.img, 'base64');
    } else {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'text/plain');
        res.end('Bad Request\n');
        return;
    }

    client.steamCommunity.sendImageToUser(requests.id, img, function (err, imageUrl) {
        if (err) {
            logger.error("an error occurred while sending image: ", err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/plain');
            res.end('Internal Server Error\n');
            return
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain');
        res.end('Success\n');
    });
}

const server = http.createServer(async (req, res) => {
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
});

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

server.listen(3000, '0.0.0.0', () => {
    console.log('Server running at http://0.0.0.0:3000/');
});
