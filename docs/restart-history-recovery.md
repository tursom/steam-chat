# 重启后的 Steam 好友消息恢复

服务器登录 Steam 或重新连接后，后台自动发现联系人并补拉 Steam 仍保留的好友历史。无需等待联系人再发送消息。已缺失的历史会在包含此修复的服务启动并登录后走同一恢复路径。

原实现有三个缺口：只有入站 `friendMessage` 才触发补拉，每个会话在进程内只尝试一次（失败也占用该次机会），并且只读取最近 100 条。这些路径可以解释重启期间消息未进入本地归档；它们不单独证明截图中某条消息的实际丢失时序。

## 恢复过程

1. `loggedOn` 开始新的连接轮次，合并 Steam active sessions、本地历史会话和 `myFriends` 中的好友。晚到的 `friendsList` 会再次补充联系人。本地会话列表也会完整分页。
2. 每个联系人从最新一页向前读取。每页指定 `startTime: 1`，避免缺省值触发 Steam 的近期 cutoff；请求保留 BBCode，以原始时间戳和 ordinal 排序、归档；当 `more_available` 为真时，以最早记录的 `lastTime` 和 `lastOrdinal` 继续。边界重叠由既有耐久事件身份消除；正文相同而 ordinal 不同的贴纸各自保留。游标不前进会报错并重试。旧历史接口返回的 `Date` 按毫秒直接使用，也兼容数字秒形式。
3. 后台导入逐条等待 RocksDB 的 `onDurable` 确认。写入队列接收成功不能代表落盘成功。全部分页都成功后，才在当前连接轮次内记为完成。历史导入不发送实时消息通知，但会触发现有耐久同步提示，客户端可通过 sync 读取补回的旧消息。
4. 会话发现、历史读取或耐久确认失败时，默认 30 秒后重试。SDK 调用和耐久确认各有默认 15 秒的超时。实时消息归档独立进行，不等待后台补拉队列。现代历史接口失败时只从旧接口抢救带完整事件身份的记录；旧 SDK 通常缺少 ordinal，这类记录等待现代接口恢复，避免每次重试追加一份、随后又与现代记录重复。旧接口抢救不会将失败的完整分页标记为完成。只有旧接口可用的兼容模式仍保留原导入行为，其元数据和分页保证不等同于现代接口。
5. 断开、退出、重新登录及关闭都会取消旧轮次请求。旧响应不能继续归档或发起下一页查询。新的 SDK 实例登录时重新绑定 `chat` 事件监听。关闭取消后台恢复；下次登录从头扫描，复用耐久去重，因此无需新增恢复检查点文件。

实现位于 `src/steam/history-recovery.ts`、`src/steam/message-logger.ts` 和 `src/steam/friend-message-events.ts`。`historyRetryMs`、`historyTimeoutMs` 是 logger 构造选项，方便确定性故障回归；没有新增用户配置入口。

## 验证

```sh
npm run build
STEAM_CHAT_DISABLE_AUTOSTART=1 node --test dist/test/restart-history-recovery.test.js \
  dist/test/message-logger.test.js dist/test/history-integration.test.js \
  dist/test/history-idempotency.test.js dist/test/durable-sync.test.js
python3 spec/restart-history/check.py --jar /absolute/path/to/tla2tools.jar
```

TLA+ 规约、旧算法与变异反例、运行方法和检查结果见 [spec/restart-history](../spec/restart-history/README.md)。实现测试使用本地 SDK 替身及真实存储，不连接 Steam；TLC 的有界结果不等于实际生产已恢复。

恢复要求 Steam 仍能返回相关历史，并且连接与存储最终恢复可用。无法从截图重建消息的 Steam 时间戳和 ordinal，也无法恢复 Steam 已删除或未返回的数据。当前没有跨进程完成缓存，每次登录会重新扫描可发现联系人的保留历史；导入按联系人串行执行，以限制上游和存储负载。
