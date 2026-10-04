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
    // Server WebSocket ping interval (ms); keep below reverse-proxy idle timeouts. 0 disables.
    wsHeartbeatMs: 45000,
    auth: {
      username: '',
      password: '',
      realm: 'Steam Chat',
      trustProxy: false
    }
  }
};
