# 多图批次顺序：模型检查结果

有序批次已在源码中实现；旧算法及变异仍作为反例对照，预期违反指定性质。模型检查与真实函数回放分别列出，不代表已部署。

整体结果：**全部符合预期**。

基准提交：`06ed5cf83429d4425c8f742e3540fdc20782c4c3`；具体输入以 SHA-256 为准。

完整证据：`/root/.cache/steam-chat-tla/image-batch-d9jtrwm3`。

TLC 实测版本：`2.19 of 08 August 2024 (rev: 5a47802)`；单 worker、seed=1、fp=0、512 MiB 堆；Node `v26.13.0`，TypeScript `6.0.3`。

| 检查 | 预期 | 退出码 | 不同状态数 | 轨迹状态数 | 符合 |
| --- | --- | ---: | ---: | ---: | --- |
| legacy-two-inversions | AcceptedInInputOrder | 12 | 1042 | 13 | 是 |
| legacy-serial-file-reads | AcceptedInInputOrder | 12 | 1002 | 13 | 是 |
| legacy-fully-ordered-preparation | AcceptedInInputOrder | 12 | 434 | 13 | 是 |
| candidate-two-faults | pass | 0 | 1099 | 0 | 是 |
| candidate-three-faults | pass | 0 | 20658 | 0 | 是 |
| candidate-three-healthy | pass | 0 | 257 | 0 | 是 |
| candidate-restart | pass | 0 | 1783 | 0 | 是 |
| candidate-healthy-liveness | pass | 0 | 53 | 0 | 是 |
| candidate-three-healthy-liveness | pass | 0 | 257 | 0 | 是 |
| reachable-reverse-file-read | NotReverseRead | 12 | 4 | 2 | 是 |
| reachable-all-sent | NotAllSent | 12 | 923 | 18 | 是 |
| reachable-unknown-blocks | NotUnknownBlocking | 12 | 468 | 13 | 是 |
| reachable-head-retry | NotRetryThenSent | 12 | 377 | 12 | 是 |
| reachable-safe-explicit-skip | NotSafeSkipThenSent | 12 | 901 | 17 | 是 |
| reachable-late-accept-after-restart | NotLateAcceptAfterRestart | 12 | 268 | 10 | 是 |
| mutation-unknown-releases-next | AcceptedInInputOrder | 12 | 925 | 17 | 是 |
| mutation-replay-unknown | NoDuplicateAccept | 12 | 646 | 14 | 是 |
| mutation-cancel-commit-as-unsent | AcceptedInInputOrder | 12 | 1102 | 17 | 是 |
| mutation-skip-upload-drain | NoSilentRelease | 12 | 523 | 13 | 是 |
| mutation-forget-and-skip | NoSilentRelease | 12 | 194 | 9 | 是 |
| mutation-forget-unknown-reorders | AcceptedInInputOrder | 12 | 1374 | 18 | 是 |
| missing-state-fails-closed | pass | 0 | 1384 | 0 | 是 |

**当前源码函数**回放退出码：`0`，验证先登记、逆序准备仍按序发送、unknown 阻塞与旧实例拒绝；无批次任务并发保留为对照。完整 HTTP／浏览器检查另见 README。

| 输入 | SHA-256 |
| --- | --- |
| `spec/image-batch-order/ImageBatch.tla` | `fa8b315f185605cf871f8ac6a98e132dd27ce28ca15dfb00df32ca9cf7b8a867` |
| `spec/image-batch-order/cases.json` | `b4e4a6854a4c64251ec69d18e217353d3e98c8879c714f8c579afa0312f62dee` |
| `spec/image-batch-order/check.py` | `c2bf8cfd260d92de99023a335951e70ca802545a48ded54b74066e16dff94873` |
| `spec/image-batch-order/replay.test.cjs` | `6ccf79d6488e2ca764de0f7eccbfe07f36bb7dce590740abe4675d65299c8675` |
| `spec/image-batch-order/README.md` | `37187cf283caff6bc9909eb6644147bc9764ee89b56731e5c7cc81fd85f0b29f` |
| `web/app.ts` | `77c538a879cdaedd398936a2e9190e3714e38824539213c4dc4cb9339f682b05` |
| `src/server/send-operations.ts` | `c541321866c2b9676d2572b920a8c337b604f428113347b8d38f731103635877` |
| `src/server/image-upload.ts` | `b491696075134c4da6b639079bb1cc39293ac7e641e6c4853e9d84a8e0a225f6` |
| `src/server/chat-service.ts` | `e94ecec2b041ce80af10203e54f90c29abfa103c608c8bb3697a799885a91c1c` |
| `test/send-operations.test.ts` | `6f161bcdf3332f205787d723d0411e3f843a62809961642c20f73f256ff93471` |
| `test/send-operations-api.test.ts` | `932372ec8b9e11e5e65f75d3683b2ef421eb209b326e70cb27ff0ac6248ed421` |
| `test/web-image-paste.test.ts` | `7667d6f0feefcd56b08c4165e1d2efb56af500690095b16a3f4d7c7250d4dc40` |
| `test/browser/image-batch-order.cjs` | `2b93676e8e92328596a3f317944db00d8c0a278d14935a37bf50aab35223c5a4` |
| `docs/message-retry-design.md` | `2ce6e2515e81554d21696b089a9c22fda581699ff11f9b6453b42504fb9adf80` |
| `package.json` | `5034d7dcb023170d3d62d2f0c316b3cf59a54d9312fe8e641022c98023c8c8f5` |
| `package-lock.json` | `0964a85ee2281a21af2f84b08cf2fa399beddae5067529f917588c192e5078f1` |
| `tla2tools.jar` | `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88` |

模型或源码变化后需重跑；有界通过不代表任意规模证明。
