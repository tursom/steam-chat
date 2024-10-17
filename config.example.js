function getRandomInt(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min)) + min;
}

module.exports = {
    accountName: 'accountName',
    password: 'password',
    logonID: getRandomInt(1000000, 999999999),
    steamID: "xxxxxxxxxx",
    chat: false,
};
