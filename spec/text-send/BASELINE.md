# 文字发送模型检查结果

由 `python3 spec/text-send/check.py` 生成。预期反例与通过项必须全部匹配。

整体结果：**全部符合预期**。

完整运行证据：`/root/.cache/steam-chat-tla/text-send-ajco0ryb`。

基准提交：`787b75832c0288d91275da23feec17259d406590`；具体输入以以下 SHA-256 为准。

TLC：单 worker、固定 seed=1、fp=0、Java 堆上限 512 MiB；状态规模有界。

Node.js `v26.13.0`；TypeScript `6.0.3`。

| 检查 | 预期 | 退出码 | 不同状态数 | 轨迹状态数 | 符合预期 |
| --- | --- | ---: | ---: | ---: | --- |
| current-safety | pass | 0 | 133098 | 0 | 是 |
| external-attribution | NoFalseAttribution | 12 | 22 | 4 | 是 |
| replacement-attribution | NoFalseAttribution | 12 | 113 | 7 | 是 |
| late-known-check | NoStuckKnownCheck | 12 | 85 | 9 | 是 |
| existing-known-check | NoStuckKnownCheck | 12 | 81 | 7 | 是 |
| known-result-liveness | temporal | 13 | 88 | 11 | 是 |
| reachable-lost-ack | NotLostAck | 12 | 57 | 7 | 是 |
| reachable-late-visible | NotLateVisible | 12 | 58 | 7 | 是 |
| reachable-replacement | NotReplacement | 12 | 33 | 5 | 是 |
| reachable-explicit-duplicate | NotTwoAcceptedCopies | 12 | 227 | 8 | 是 |
| mutation-auto-replay | NoAutomaticReplay | 12 | 22 | 5 | 是 |
| mutation-match-all | OneEventOneHeuristicClaim | 12 | 103 | 5 | 是 |
| mutation-empty-is-failure | FailureSoundness | 12 | 74 | 8 | 是 |
| guard-failure-soundness | FailureSoundness | 12 | 9 | 7 | 是 |
| guard-manual-retry-duplicate | NoUnintendedDuplicate | 12 | 14 | 11 | 是 |
| guard-without-mismatch | pass | 0 | 6 | 0 | 是 |

真实前端函数回放退出码：`0`。

输入指纹：

| 文件 | SHA-256 |
| --- | --- |
| `spec/text-send/TextSend.tla` | `a33b9d336a5db32d96374f2c28bef67136995594cef60d39270ae4ea288fae78` |
| `spec/text-send/TextSendGuard.tla` | `349c48d0773baad3ee746a6427d0344768bbf0a78757d210220887e3e83de916` |
| `spec/text-send/cases.json` | `df9635a21eb255d4bd394edd9d6b34c778bc88eafe44a2e1860005d1d1bdfa1f` |
| `spec/text-send/check.py` | `218c554d0f55dd13383e917ddedc47201a7fd5bb099fa303bfb993e5dde0ba96` |
| `spec/text-send/replay.test.cjs` | `949794e314c4848d50a147b8c83603af99c79706d246d192165a042312faf5bf` |
| `spec/text-send/README.md` | `50b411ded7f2e286aaa23aad73b27230638883bbb856f20d2e79335979348ca7` |
| `web/app.ts` | `d7655e4e38ca980798e79735fa65673df5a19ac12f5c7b1b4909aab74fbbdf7a` |
| `src/server/chat-service.ts` | `341bc1e57a24996f1accf97a5761537f40e7d6e7d43fa0a195a1c49b969696f7` |
| `docs/message-retry-design.md` | `75d468a2108f800874a936bcdd838a41617bba9b77fd3b9dab543822da350c0a` |
| `tla2tools.jar` | `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88` |

另有源码及依赖声明，共 `46` 个输入文件的快照和指纹保存在 `manifest.json`。

源码或模型变化后，本表不再是新版本的验证证据。完整日志、配置、输入快照和 manifest 在证据目录中。
