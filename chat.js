client = require("./client")

const http = require('http');
const {once} = require("node:events");

const server = http.createServer(async (req, res) => {
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString(); // 将Buffer转换为字符串
    });

    await once(req, 'end');

    let requests = JSON.parse(body);

    console.log(requests.id)
    console.log(requests.msg)

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
});

server.listen(3000, '127.0.0.1', () => {
    console.log('Server running at http://127.0.0.1:3000/');
});
