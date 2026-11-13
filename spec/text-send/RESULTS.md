# 文字发送模型检查结果

由 `python3 spec/text-send/check.py` 生成。预期反例与通过项必须全部匹配。

整体结果：**全部符合预期**。

完整运行证据：`/root/.cache/steam-chat-tla/text-send-lc1ymolf`。

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
| fixed-evidence-safety | pass | 0 | 86285 | 0 | 是 |
| fixed-existing-check | pass | 0 | 173 | 0 | 是 |
| fixed-late-check | pass | 0 | 87 | 0 | 是 |
| fixed-known-evidence-liveness | pass | 0 | 87 | 0 | 是 |
| fixed-known-evidence-reachable | NotKnownEvidence | 12 | 44 | 6 | 是 |
| fixed-guard-safety | pass | 0 | 10 | 0 | 是 |
| fixed-guard-server-only | pass | 0 | 10 | 0 | 是 |
| fixed-guard-client-only | pass | 0 | 10 | 0 | 是 |
| mutation-evidence-skip-existing | NoStuckKnownCheck | 12 | 84 | 7 | 是 |
| mutation-evidence-thirty-seconds | NoStuckKnownCheck | 12 | 84 | 9 | 是 |

真实前端函数回放退出码：`0`。

输入指纹：

| 文件 | SHA-256 |
| --- | --- |
| `spec/text-send/TextSend.tla` | `6e442143ffae8fd2caabc54bf85e089c6f7fabd59d13622f56e62bad493a9fc9` |
| `spec/text-send/TextSendEvidence.tla` | `1ced332d25597c5d3201a278d1681804097005f59f62c8843609cc485bb24c64` |
| `spec/text-send/TextSendGuard.tla` | `c2efadccc9270a9a4f2cc703f5a56efc2e965d836a96acf14460aaed8e5e92f3` |
| `spec/text-send/cases.json` | `d8da761011967e330a867b1a8e5f63c1c16ac58344a71bad9de58979f51dc709` |
| `spec/text-send/check.py` | `812d9fb40f72c50ed214fb0865d898335bd5919eedb8a5558f617a69868fc971` |
| `spec/text-send/replay.test.cjs` | `4d9410d993ab32d68eb393051c56899a2da966d10a4db7d5768551e6299d5c72` |
| `spec/text-send/README.md` | `8d1ac5e884803c9321c0da1bada8e4d57384cbee0463dbd32d636193f01d35f9` |
| `web/app.ts` | `26095ccf25455a2b68c7494e83f33249b4a393f4b1cec730f488dd5229a09a2c` |
| `src/server/chat-service.ts` | `317584b4300eed0b41b78636efc3ac9dc1965b1cdb67c9fa71a0ad4b108b0e86` |
| `docs/message-retry-design.md` | `ded4cfc7f9ce22b7b1b2b3c1d8ed9428e69199ccb2740ee29928483468ccae0c` |
| `tla2tools.jar` | `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88` |

另有源码及依赖声明，共 `47` 个输入文件的快照和指纹保存在 `manifest.json`。

源码或模型变化后，本表不再是新版本的验证证据。完整日志、配置、输入快照和 manifest 在证据目录中。
