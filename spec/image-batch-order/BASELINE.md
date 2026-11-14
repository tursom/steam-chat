# 多图批次顺序：模型检查结果

**候选协议仅存在于模型中，生产代码未实现排序。** 旧算法反例/变异失败是预期结果。

整体结果：**全部符合预期**。

基准提交：`06ed5cf83429d4425c8f742e3540fdc20782c4c3`；具体输入以 SHA-256 为准。

完整证据：`/root/.cache/steam-chat-tla/image-batch-abzr3sev`。

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

**当前生产函数**回放退出码：`0`，用于复现现状缺陷，不是候选协议的实现测试。

| 输入 | SHA-256 |
| --- | --- |
| `spec/image-batch-order/ImageBatch.tla` | `fa8b315f185605cf871f8ac6a98e132dd27ce28ca15dfb00df32ca9cf7b8a867` |
| `spec/image-batch-order/cases.json` | `b4e4a6854a4c64251ec69d18e217353d3e98c8879c714f8c579afa0312f62dee` |
| `spec/image-batch-order/check.py` | `d6d00939370f608df6dd32c4595958e9e129ff065b1e158c8dda81944e5e3597` |
| `spec/image-batch-order/replay.test.cjs` | `10bbd8994e4e4f874aa772103c523c9598a380b19bb033e3b8c4a864c609af0d` |
| `spec/image-batch-order/README.md` | `c1eea8d5e0fcc33498b773f34be140293638dd580d4063934d69cae624ba560e` |
| `web/app.ts` | `26095ccf25455a2b68c7494e83f33249b4a393f4b1cec730f488dd5229a09a2c` |
| `src/server/send-operations.ts` | `c25aeeac3111ab278fb2b8d7357558c65111f3e7c70d03821b69839801568c2e` |
| `src/server/image-upload.ts` | `b491696075134c4da6b639079bb1cc39293ac7e641e6c4853e9d84a8e0a225f6` |
| `src/server/chat-service.ts` | `317584b4300eed0b41b78636efc3ac9dc1965b1cdb67c9fa71a0ad4b108b0e86` |
| `package.json` | `5034d7dcb023170d3d62d2f0c316b3cf59a54d9312fe8e641022c98023c8c8f5` |
| `package-lock.json` | `0964a85ee2281a21af2f84b08cf2fa399beddae5067529f917588c192e5078f1` |
| `tla2tools.jar` | `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88` |

模型或源码变化后需重跑；有界通过不代表任意规模证明。
