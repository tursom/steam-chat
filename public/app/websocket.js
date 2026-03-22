export function createWebSocketController({
  setStatus,
  setConnectionStatus,
  savePreferences,
  clearPendingUploadRequests,
  onReady,
  onEmoticons,
  onConversations,
  onFriends,
  onGroups,
  onHistory,
  onMessage,
  onMessageSent,
  onImageSent,
  onError,
}) {
  let socket = null;
  let nextRequestId = 1;

  function createRequestId(prefix) {
    return String(prefix || 'req-') + (nextRequestId++);
  }

  function send(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setStatus('WebSocket 未连接');
      return false;
    }

    savePreferences();
    socket.send(JSON.stringify(payload));
    return true;
  }

  function requestConversations(limit = 200) {
    send({
      type: 'get_conversations',
      requestId: createRequestId('conv-'),
      limit,
    });
  }

  function requestFriends() {
    send({
      type: 'get_friends',
      requestId: createRequestId('friends-'),
    });
  }

  function requestGroups() {
    send({
      type: 'get_groups',
      requestId: createRequestId('groups-'),
    });
  }

  function requestHistory(id, limit) {
    send({
      type: 'get_history',
      requestId: createRequestId('history-'),
      id,
      limit,
    });
  }

  function requestEmoticons() {
    send({
      type: 'get_emoticons',
      requestId: createRequestId('emoticons-'),
    });
  }

  function connect(wsPath) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    setConnectionStatus('connecting', '连接中');
    socket = new WebSocket(protocol + '//' + location.host + wsPath);

    socket.addEventListener('open', () => {
      setConnectionStatus('connected', '已连接');
      setStatus('WebSocket 已连接');
    });

    socket.addEventListener('close', () => {
      clearPendingUploadRequests('连接已断开');
      setConnectionStatus('connecting', '3 秒后重连');
      setStatus('WebSocket 已断开，3 秒后重连');
      setTimeout(() => connect(wsPath), 3000);
    });

    socket.addEventListener('error', () => {
      setConnectionStatus('error', '连接异常');
      setStatus('WebSocket 连接异常');
    });

    socket.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        setStatus('收到无法解析的消息');
        return;
      }

      switch (payload.type) {
        case 'ready':
          setConnectionStatus('connected', '已同步');
          setStatus('WebSocket 已连接');
          onReady();
          break;
        case 'emoticons':
          onEmoticons(payload.data);
          break;
        case 'conversations':
          onConversations(payload.data);
          break;
        case 'friends':
          onFriends(payload.data);
          break;
        case 'groups':
          onGroups(payload.data);
          break;
        case 'history':
          onHistory(payload.data);
          break;
        case 'message':
        case 'image':
          onMessage(payload.data);
          break;
        case 'message_sent':
          onMessageSent(payload);
          break;
        case 'image_sent':
          onImageSent(payload);
          break;
        case 'error':
          onError(payload);
          break;
        case 'pong':
          break;
        default:
          console.log('unknown payload', payload);
      }
    });
  }

  return {
    connect,
    createRequestId,
    requestConversations,
    requestEmoticons,
    requestFriends,
    requestGroups,
    requestHistory,
    send,
  };
}
