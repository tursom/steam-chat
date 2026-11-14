# TLC 反例阅读索引

以下是实际 TLC 轨迹的摘要，完整状态、退出码和配置均在链接目录中。事件编号为模型的 `number` 字段，默认扫描顺序为 2、1、3；事件 2 和 1 正文、秒、方向相同而 ordinal 不同。

| 场景及完整日志 | 指定性质 | 关键轨迹与最终事实 |
| --- | --- | --- |
| [旧算法静默缺失](evidence/legacy-silent-without-inbound/tlc.txt) | `Recovery` | 初态没有入站事件，`discovered={}`、`archive={}`；State 2 为 Stuttering。所有持续启用的工作均符合公平性，却没有任何历史恢复 |
| [旧算法单页截断](evidence/legacy-single-page/tlc.txt) | `CompleteOnlyArchived` | 入站触发 → 开始并缓存 attempted → 请求 → 只取事件 2 → 提交 → State 7 完成；事件 1、3 未归档 |
| [候选算法单页变异](evidence/mutation-single-page/tlc.txt) | `CompleteOnlyArchived` | 自动发现成功，仍在第一满页后完成；State 7 与旧单页相同缺失。说明主动发现本身不能解决分页截断 |
| [失败缓存](evidence/mutation-failure-cache/tlc.txt) | `Recovery` | State 3 开始时 `attempted={1}` → State 4 失败消耗唯一故障预算 → State 5 定时器释放任务但 attempted 不清 → State 6 永久 Stuttering；故障已停止仍无法重新开始 |
| [提前完成](evidence/mutation-early-complete/tlc.txt) | `CompleteOnlyArchived` | State 3 的 Start 直接写 `done={1}`，但 `archive={}`，无需等到请求或崩溃即可发现错误 |
| [移除轮次检查](evidence/mutation-no-round-guard/tlc.txt) | `NoStaleCallbacks` | 轮次 0 请求在途 → State 5 同账号 A 重连到轮次 1 → State 6 接受旧响应；`job.round=0`、`round=1`、`badCallback=TRUE` |
| [移除整个账号/轮次令牌检查](evidence/mutation-no-token-account-leak/tlc.txt) | `AccountIsolation` | A 的历史页读回 → State 6 切到 B → State 7 将 A 的事件写入 bucket B；不是仅观察标志，而是实际归档分区与事件来源不一致 |
| [旧任务继续翻页查询](evidence/mutation-stale-followup/tlc.txt) | `NoStaleQueries` | 第一页事件 2 已保存 → State 7 游标推进到 `(2,2)` → State 8 切轮次 → State 9 旧任务发出下一页请求，`badQuery=TRUE`；回调检查仍开启 |
| [正文+秒去重](evidence/mutation-body-dedup/tlc.txt) | `NoFalseMerge` | 事件 2 已保存 → 下一页事件 1 被错误判断为重复 → State 10 的 receipts 含事件 1，archive 却仅含事件 2；还没标记完成就已丢失独立事件 |
| [只按秒分页](evidence/mutation-time-only-cursor/tlc.txt) | `CompleteOnlyArchived` | 第一页事件 2 的秒为 2 → 下一页只查 `< 2`，跳过同秒 ordinal=1 的事件 1 → 保存事件 3 → State 11 完成，archive 缺事件 1 |

安全反例均要求退出码 12 且输出精确的性质名。两个活性反例要求退出码 13、配置唯一 `PROPERTY Recovery`、真实轨迹和停滞结尾；TLC 2.19 不在活性报错正文中输出性质名，因此必须连同配置审阅。不能把语法错误、超时或其他性质失败视为这些反例。

三个可达性哨兵也按预期失败，但刻意检查的是“永远到不了恢复成功”的反命题：

- [部分归档后崩溃并精确重放](evidence/reachable-partial-crash-replay/tlc.txt)：State 6 保存事件 2，State 7 崩溃，State 8 重新登录，State 9 重新发现；State 13 重扫相同事件、保持唯一归档；State 22 所有事件归档且本轮完成。命中 `NeverRecoveredAfterPartialCrash`。
- [故障后重试成功](evidence/reachable-retry-recovery/tlc.txt)：State 4 失败、State 5 定时器触发、State 6 重新开始、State 18 完成，命中 `NeverRecoveredAfterRetry`。
- [三个发现来源全部恢复](evidence/reachable-three-sources/tlc.txt)：State 2–4 将三个独占来源的联系人合并；State 43 全部联系人历史齐全并完成，命中 `NeverAllSourcesRecovered`。

哨兵验证对应场景可达，修复模型的安全性与活性仍由三个 `fixed-*` 配置独立检查。全部结果和输入指纹见 [RESULTS.md](RESULTS.md)。
