module.exports = {
  accountName: 'your_steam_login_name',
  password: 'your_steam_password',
  logonID: Math.floor(Math.random() * 0x7fffffff),
  steamID: '',
  identitySecret: '',
  chat: {
    enabled: true,
    host: '0.0.0.0',
    port: 3000,
    wsPath: '/ws',
    auth: {
      username: '',
      password: '',
      realm: 'Steam Chat',
      trustProxy: false
    }
  }
};
