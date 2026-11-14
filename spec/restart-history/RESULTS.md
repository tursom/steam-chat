# 重启历史恢复：TLC 实测结果

整体结果：**全部符合预期**。

由 `check.py` 实际调用 Java/TLC 生成。模型结果仅适用于有界抽象，生产实现另用集成回归验证。

TLC：`TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)`；单 worker、seed=1、fp=0、512 MiB 堆。

每项保留模型、配置、完整日志和命令；输入快照及 SHA-256 见 [manifest](evidence/manifest.json)。

活性反例的性质名由配置中唯一的 PROPERTY 精确核对（TLC 的活性错误正文不输出名字）；
另须退出码 13、完整轨迹及循环/停滞结尾。安全反例须退出码 12 且日志中的性质名精确匹配。

| 检查 | 预期 | 退出码 | 不同状态 | 轨迹状态 | 符合 |
| --- | --- | ---: | ---: | ---: | --- |
| [fixed-combined](evidence/fixed-combined/tlc.txt) | pass | 0 | 3,614 | 0 | 是 |
| [fixed-three-discovery-sources](evidence/fixed-three-discovery-sources/tlc.txt) | pass | 0 | 351 | 0 | 是 |
| [fixed-two-item-page](evidence/fixed-two-item-page/tlc.txt) | pass | 0 | 321 | 0 | 是 |
| [legacy-silent-without-inbound](evidence/legacy-silent-without-inbound/tlc.txt) | Recovery | 13 | 1 | 2 | 是 |
| [legacy-single-page](evidence/legacy-single-page/tlc.txt) | CompleteOnlyArchived | 12 | 7 | 7 | 是 |
| [mutation-single-page](evidence/mutation-single-page/tlc.txt) | CompleteOnlyArchived | 12 | 7 | 7 | 是 |
| [mutation-failure-cache](evidence/mutation-failure-cache/tlc.txt) | Recovery | 13 | 28 | 6 | 是 |
| [mutation-early-complete](evidence/mutation-early-complete/tlc.txt) | CompleteOnlyArchived | 12 | 3 | 3 | 是 |
| [mutation-no-round-guard](evidence/mutation-no-round-guard/tlc.txt) | NoStaleCallbacks | 12 | 25 | 6 | 是 |
| [mutation-no-token-account-leak](evidence/mutation-no-token-account-leak/tlc.txt) | AccountIsolation | 12 | 43 | 7 | 是 |
| [mutation-stale-followup](evidence/mutation-stale-followup/tlc.txt) | NoStaleQueries | 12 | 47 | 9 | 是 |
| [mutation-body-dedup](evidence/mutation-body-dedup/tlc.txt) | NoFalseMerge | 12 | 10 | 10 | 是 |
| [mutation-time-only-cursor](evidence/mutation-time-only-cursor/tlc.txt) | CompleteOnlyArchived | 12 | 11 | 11 | 是 |
| [reachable-partial-crash-replay](evidence/reachable-partial-crash-replay/tlc.txt) | NeverRecoveredAfterPartialCrash | 12 | 65 | 22 | 是 |
| [reachable-retry-recovery](evidence/reachable-retry-recovery/tlc.txt) | NeverRecoveredAfterRetry | 12 | 59 | 18 | 是 |
| [reachable-three-sources](evidence/reachable-three-sources/tlc.txt) | NeverAllSourcesRecovered | 12 | 351 | 43 | 是 |

实现回归：`{'buildExitCode': 0, 'testExitCode': 0}`（None 表示本次未运行）。
日志见 `evidence/build.txt` 和 `evidence/implementation.txt`；使用本地 SDK 替身与真实归档存储，不连接 Steam。

输入指纹：

| 输入 | SHA-256 |
| --- | --- |
| `RestartHistory.tla` | `13e00c5d79578c328395c1e1c8749a2abc694a1f4abe281859bebc67d7d9114f` |
| `cases.json` | `4250ba996e48236f22c59b4c7bed5140517358798411e0d6629aa039397aa325` |
| `check.py` | `930fe1a25addd2a1ba5d66360cba816c7e8d093c0aacc8c52f3475144d7db0d6` |
| `README.md` | `41c5ac38fd38a78aec7272fb53b1fae3f688a4b92da3351318e8c87edfbb829f` |
| `COUNTEREXAMPLES.md` | `41b5108c634cf5cdf8c9aed51a3f75c6dfb8550df18e20fa8bdf190f6bb94d37` |
| `src/steam/history-recovery.ts` | `80f8c5a7303added21713965a3bcf0228a41dc097d1c37b2259fc4da06542308` |
| `src/steam/message-logger.ts` | `f0960238b8e6b9bf67d7ea48e5462a9bf6c6271650b86fcb0d6ed8709cfcfad2` |
| `src/steam/friend-message-events.ts` | `d54596a6aaa04548dbda95aac665006d5850603aa6f893f2ee69747b093aecab` |
| `test/restart-history-recovery.test.ts` | `ef339f557fbf8abde88669b3737b3906b334aa8bd3a7c3049b801398fecfebe2` |
| `test/message-logger.test.ts` | `32977d4c4ca691f65e247db86a1ce910f5953e9778bad4a0132bd0ac5f86b21d` |
| `test/history-integration.test.ts` | `e1f08998c86044ffa155e719db2b73ad1a639931fa8c281463fb2d2175f3a7c3` |
| `test/history-idempotency.test.ts` | `3a876578681257aa2c4eac7808ee51f2f2b5cc36e1d3d1f93919ac61791efcaf` |
| `tla2tools.jar` | `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88` |

输入运行期间未变化：`True`。模型或配置变化后须重跑。
