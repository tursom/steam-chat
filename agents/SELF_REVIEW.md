# 通用功能模块自评审流程

> 一键触发：`ulw 启动自评审流程，目标：<包路径 | 功能模块描述>`
> 交互触发：`ulw 我要自评审`（逐步问答，无需记参数）
> 示例：`ulw 启动自评审流程，目标：core/helper/search`
> 示例：`ulw 启动自评审流程，目标：订单结算流程`
> 示例：`ulw 启动自评审流程，目标：库存同步与发货`

## 触发方式

支持两种触发模式：

### 模式 1：直接触发（参数完整）

适合熟悉格式、一次性写全的场景。

Sisyphus 将根据输入自动判断目标类型：

- **Go 包路径**（包含 `/` 或 `.`，如 `core/helper/search`）→ 走包发现模式
- **功能模块描述**（自然语言，如 `订单结算流程`）→ 走功能模块发现模式
- **手动指定文件清单**：在上述参数后追加 `|` 分隔的文件路径，跳过自动发现

```
ulw 启动自评审流程，目标：<TARGET> [| file1.go,file2.go] [可选: 额外上下文]
```

额外上下文示例：
- `该模块负责订单结算，依赖 MySQL + Redis`
- `该模块是新增的，需要特别注意错误处理`
- `重点审查并发安全性`
- `涉及多服务交互：go-game-trade-serve → go-goods-serve`

### 模式 2：交互式触发（推荐）

记不住格式、或者想一步步来的时候用。无需记忆任何参数。

```
ulw 我要自评审
```

Sisyphus 收到后将通过对话逐项询问：

1. **评审目标** — 包路径？功能模块描述？还是直接给文件列表？
2. **额外上下文** — 业务背景、关注重点、涉及的服务等
3. **确认** — 展示理解到的目标，让用户确认后再启动

相当于把一次性参数填写变成了问答式引导，降低心智负担。

## Sisyphus 自动执行流程

Sisyphus 收到此请求后将执行：

### Phase 0: 文件发现

**模式 A — 按包路径发现：**
- 解析目标包路径
- `glob` + `grep` 发现包内所有 `.go` 文件
- `grep` 发现包间引用关系
- **反向发现调用者**：grep 搜索服务目录下哪些文件调用了目标包的导出函数/类型（如 `Start`、`TryPublish`、`Handle` 等入口），将这些调用者文件加入覆盖清单
  - 例：审查 `consumer/goods` 包时，发现调用它的 `game_trade.go`（API handler）和 producer 定时任务文件，加入审查范围
  - 反向发现确保端到端链路完整：调用者的日志级别、返回信息是否与模块实际行为一致
- 汇总为「覆盖文件清单」

**模式 B — 按功能模块描述发现：**
- 启动 2 个 `explore` Agent 并行探索：
  - Agent 1：根据功能描述在相关服务目录下搜索关键词、结构体、函数
  - Agent 2：根据功能描述搜索配置、路由注册、API 入口等外围文件
- 合并结果去重，形成「覆盖文件清单」
- 如发现跨服务调用，在报告中注明涉及的外部服务

**模式 C — 手动指定文件清单：**
- 跳过自动发现，直接使用用户提供的文件路径列表
- 对每个文件做存在性验证，不存在的文件报告警告

### Phase 1: 基线检查

- 若覆盖文件清单归属单一服务或单一包 → `go build ./<PACKAGE>...` + `go test ./<PACKAGE>...`
- 若跨多个包 → 对每个涉及的独立包分别运行 build + test
- 失败则先不进入审查，报告用户

### Phase 2: 审查循环 (直至质量达标)

循环核心原则：**不设轮次上限，只以质量门禁是否全部通过为终止条件。**

#### 质量门禁（必须全部通过）

| # | 门禁 | 判定方式 | 一票否决 |
|---|------|----------|----------|
| G1 | 代码正确性审查 verdict = PASS | Oracle Agent 1 | 是 |
| G2 | 安全+边界审查 verdict = PASS | Oracle Agent 2 | 是 |
| G3 | 架构+模式审查 verdict = PASS | Oracle Agent 3 | 是 |
| G4 | 攻击者测试 verdict = PASS | Oracle Agent 4 | 是 |
| G5 | 交叉验证 verdict = PASS | Sisyphus 对比 4 个 Agent 发现 | 是 |
| G6 | 误判检测 verdict = NO_MISJUDGMENT | Sisyphus 逐条复审 findings | 是 |
| G7 | 零 CRITICAL/MAJOR 残留 | 汇总所有 findings 检查 | 是 |
| G8 | 零回归问题 | 对比上一轮 findings，新引入的算回归 | 是 |
| G9 | go build 通过 | bash 执行 | 是 |
| G10 | go test 通过 | bash 执行 | 是 |

所有门禁通过（PASS）才算质量达标，否则继续循环。

#### 循环流程

```
第 N 轮:
  ├─ Phase 2a: 并行审查
  │   ├─ 启动 4 个 Oracle 并行审查（使用 Phase 0 发现的文件清单）:
  │   │   bg_1: 代码正确性 (oracle, Agent 1)
  │   │   bg_2: 安全 + 边界条件 (oracle, Agent 2)
  │   │   bg_3: 架构 + 模式 (oracle, Agent 3)
  │   │   bg_4: 攻击者测试 (oracle, Agent 4)
  │   └─ 等待全部完成
  ├─ Phase 2b: 交叉验证
  │   ├─ Agent 4 审查 Agent 1-3 的发现补充遗漏
  │   ├─ Agent 1-3 审查 Agent 4 的发现去重
  │   └─ Sisyphus 汇总生成完整 findings 清单
  ├─ Phase 2c: 质量门禁检查
  │   ├─ 全部 10 项 PASS → 输出最终报告，循环终止
  │   └─ 有 FAIL 项 → 进入修复流程
  ├─ 修复流程:
  │   ├─ 回归问题优先修复（先还旧债，再修新债）
  │   ├─ 误判优先复查（G6 FAIL 说明某条 finding 被错误判定，先纠正）
  │   ├─ 按类型分流到修复 Agent:
  │   │    单文件修改 → category="quick"
  │   │    多文件/复杂 → category="deep"
  │   └─ 修复后执行 build + test
  ├─ 如果连续 3 轮同一门禁 FAIL（僵局处理）:
  │   ├─ 启动 Oracle 深度诊断，分析为什么反复修不好
  │   ├─ 输出根因分析 + 替代方案
  │   └─ 上报用户决策：继续修 / 接受现状 / 改方案
  └─ 进入第 N+1 轮
```

#### 僵局处理（Escalation）

当连续 3 轮同一门禁 FAIL 时，说明常规修复手段无效。此时：

1. **暂停修复**，不自欺欺人继续打补丁
2. **启动 Oracle 深度诊断**，分析根因：
   - 是设计缺陷导致修不好？（如：当前架构本身就不安全）
   - 是修复引入了新问题？（如：为了修 A 破坏了 B）
   - 是审查标准不合理？（如：过于理想化，与现有代码风格冲突）
3. **输出根因分析报告**，给出 2-3 个可选方案
4. **上报用户**，由用户决策下一步方向

### Phase 3: 输出报告

## 审查 Agent 提示词模板

Sisyphus 将「覆盖文件清单」和模块上下文代入以下模板。

**所有 Agent 的 prompt 均包含四个通用要求（在模板中已内置）：**

```
通用要求（对所有维度均适用）:
R1. 时序场景模拟:
    - 识别模块中所有共享状态（全局变量、sync.Map、channel、atomic 操作等）
    - 列出每个共享状态的 所有读写操作 及其所在的函数/goroutine
    - 模拟 2-3 个 goroutine 交错时序，找出可能的竞态窗口
    - 特别关注"先释放某资源 → 其他 goroutine 获取 → 原 goroutine 再次操作该资源"的模式

R2. 逐 return 路径 cleanup 验证:
    - 对每个包含资源获取的函数，列出其所有 return 路径（正常结束、错误、超时、取消）
    - 逐路径验证 cleanup 完整性：每个 return 是否释放了该路径上已获取的所有资源
    - 比较对称路径的 cleanup 是否一致（如 if/else 分支、循环内 break vs continue vs return）

R3. 跨函数/跨文件共享状态生命周期追踪:
    - 如果一个共享状态的生命周期跨越多个函数/文件（如 producer 写入 → event bus → consumer 读取并释放）
    - 追踪该状态的完整路径，检查每个跳转点的一致性
    - 特别关注状态通过事件/参数传递时，中间件或错误路径是否会中断传递

R4. 隐式假设陷阱扫描:
    - 代码中的每个硬编码值（超时时长、重试次数/间隔、批大小、并发数、缓冲区容量、轮询频率）都隐含了一个对业务场景的假设。
      对这些假设逐条问:
      a) 这个值假定外部系统（AI API、DB、下游服务）的响应多快？负载多高？该假设在最坏情况下还成立吗？
      b) 这个值假定同时存在多少个并发操作？如果同时有 100 个而不是 1 个，还成立吗？
      c) 如果假设不成立，代码是"优雅退化"还是"直接中断"？中断后是否有补偿机制？
      d) 代码是否将"正常情况"和"边界情况"用了同一个值？（例如：重获取锁超时 = 5 秒，假设 priority 在 5 秒内跑完；但 priority 实际耗时可达 30 分钟——正常路径和边界路径混用了同一套超时）
      e) 是否存在"读取时看起来安全，写入时暴露假设"的代码？（例如：`LoadInt64 > 0` 的检查与后续操作之间假设了状态不变）
    - 除了硬编码值，还有一类更隐蔽的隐式假设——**代码结构本身隐含的对系统行为的假设**。对以下每类逐条排查:
      f) **事件/消息投递假设**: 是否假设"发布成功 = 一定被执行"？发布后的链路是否有超时/取消/panic 导致静默丢弃的路径？调用方的"成功日志"和实际执行之间有 gap 吗？
      g) **并发与 goroutine 模型假设**: 是否假设其他 goroutine 一定活着？是否假设 state 在读和写之间不变？是否假设信号量/buffer 永远不会满？
      h) **错误传播假设**: 是否用 `ctx.Err()` 代替了被包裹的底层 err？是否假设错误一定是某种特定类型？错误链路上是否有被吞没的中间错误？
      i) **key/标识符空间隔离假设**: 不同用途的 key（如 `game:<appID>` vs `game:batch:<hash>`）是否可能碰撞？token/ID 的生成方式是否保证全局唯一？
      j) **外部系统行为假设**: 是否假设外部 API 稳定返回特定格式？是否假设失败原因可被 binary split 重试解决？是否假设外部系统不会永久性失败？
      k) **defer 注册时序假设**: 所有资源释放（锁、token、channel close、连接归还等）的 defer 是否在 `ctx.Done()` 检查之前注册？如果 defer 注册在 ctx 检查之后，ctx 恰好在这两步之间取消时，defer 不会执行，资源永久泄漏。审阅每条 early‑return 路径：确认 defer 注册 → 确认 ctx 检查在 defer 之后。
      l) **契约边界假设**: 找出所有仅靠"当前代码路径唯一"维持的不变量（如单次订阅、单点初始化、单消费者语义）。对每个不变量，追问：如果路径倍增（重复订阅/重入/串跑/重启），系统是快速失败还是静默损坏？是否有恢复机制？是否存在调用方已假定"约束永远成立"但实现层没有任何防御的断裂点？
      m) **状态信息不完备假设**: 系统通过有限的状态信息（计数器、字段、信号量、缓存值）来代表真实世界。任何状态信息都可能因聚合粒度、传递损耗或更新延迟而与真实状态不符。对每个状态信息，追问：它在什么场景下会失准？失准时系统的行为是快速失败还是静默输出错误结果？

```

### Agent 1: 代码正确性

```
task(subagent_type="oracle", load_skills=[], run_in_background=true,
  description="Review correctness of MODULE_NAME",
  prompt="""
<review_type>CODE CORRECTNESS + QUALITY REVIEW</review_type>
<module>{MODULE_NAME}</module>
<files>{NEWLINE_SEPARATED_FILE_LIST_WITH_FULL_CONTENT}</files>
<context>{MODULE_SPECIFIC_CONTEXT_FROM_USER}</context>

通用要求:
R1. 时序场景模拟:
    - 识别模块中所有共享状态（全局变量、sync.Map、channel、atomic 操作等）
    - 列出每个共享状态的 所有读写操作 及其所在的函数/goroutine
    - 模拟 2-3 个 goroutine 交错时序，找出可能的竞态窗口
    - 特别关注"先释放某资源 → 其他 goroutine 获取 → 原 goroutine 再次操作该资源"的模式

R2. 逐 return 路径 cleanup 验证:
    - 对每个包含资源获取的函数，列出其所有 return 路径（正常结束、错误、超时、取消）
    - 逐路径验证 cleanup 完整性：每个 return 是否释放了该路径上已获取的所有资源
    - 比较对称路径的 cleanup 是否一致（如 if/else 分支、循环内 break vs continue vs return）

R3. 跨函数/跨文件共享状态生命周期追踪:
    - 如果一个共享状态的生命周期跨越多个函数/文件
    - 追踪该状态的完整路径，检查每个跳转点的一致性
    - 特别关注状态通过事件/参数传递时，中间件或错误路径是否会中断传递

R4. 隐式假设陷阱扫描:
    - 代码中的每个硬编码值（超时时长、重试次数/间隔、批大小、并发数、缓冲区容量、轮询频率）都隐含了一个对业务场景的假设。
      对这些假设逐条问:
      a) 这个值假定外部系统（AI API、DB、下游服务）的响应多快？负载多高？该假设在最坏情况下还成立吗？
      b) 这个值假定同时存在多少个并发操作？如果同时有 100 个而不是 1 个，还成立吗？
      c) 如果假设不成立，代码是"优雅退化"还是"直接中断"？中断后是否有补偿机制？
      d) 代码是否将"正常情况"和"边界情况"用了同一个值？
      e) 是否存在"读取时看起来安全，写入时暴露假设"的代码？
    - 除了硬编码值，还有一类更隐蔽的隐式假设——**代码结构本身隐含的对系统行为的假设**。对以下每类逐条排查:
      f) **事件/消息投递假设**: 是否假设"发布成功 = 一定被执行"？发布后的链路是否有超时/取消/panic 导致静默丢弃的路径？调用方的"成功日志"和实际执行之间有 gap 吗？
      g) **并发与 goroutine 模型假设**: 是否假设其他 goroutine 一定活着？是否假设 state 在读和写之间不变？是否假设信号量/buffer 永远不会满？
      h) **错误传播假设**: 是否用 `ctx.Err()` 代替了被包裹的底层 err？是否假设错误一定是某种特定类型？错误链路上是否有被吞没的中间错误？
      i) **key/标识符空间隔离假设**: 不同用途的 key（如 `game:<appID>` vs `game:batch:<hash>`）是否可能碰撞？token/ID 的生成方式是否保证全局唯一？
      j) **外部系统行为假设**: 是否假设外部 API 稳定返回特定格式？是否假设失败原因可被 binary split 重试解决？是否假设外部系统不会永久性失败？
      k) **defer 注册时序假设**: 所有资源释放（锁、token、channel close、连接归还等）的 defer 是否在 `ctx.Done()` 检查之前注册？如果 defer 注册在 ctx 检查之后，ctx 恰好在这两步之间取消时，defer 不会执行，资源永久泄漏。审阅每条 early‑return 路径：确认 defer 注册 → 确认 ctx 检查在 defer 之后。
      l) **契约边界假设**: 找出所有仅靠"当前代码路径唯一"维持的不变量（如单次订阅、单点初始化、单消费者语义）。对每个不变量，追问：如果路径倍增（重复订阅/重入/串跑/重启），系统是快速失败还是静默损坏？是否有恢复机制？是否存在调用方已假定"约束永远成立"但实现层没有任何防御的断裂点？
      m) **状态信息不完备假设**: 系统通过有限的状态信息（计数器、字段、信号量、缓存值）来代表真实世界。任何状态信息都可能因聚合粒度、传递损耗或更新延迟而与真实状态不符。对每个状态信息，追问：它在什么场景下会失准？失准时系统的行为是快速失败还是静默输出错误结果？
Review for:
- Logic errors
- Concurrency issues: 死锁、活锁、竞态条件、双释放、ABA 问题、原子操作误用
- 共享的 sync.Map/atomic.Pointer 等原语：区分"操作本身安全"和"业务语义安全"
  （例如：sync.Map.Delete 是幂等的，但如果当前存储的是其他 goroutine 的 token，
   删除它就破坏了其他持有者的锁 — 这种"跨 goroutine 的语义安全性"）
- defer cleanup 的覆盖完整性：所有获取操作是否有对应的 defer/手动释放
- Error handling gaps: 错误被吞没、错误类型误判（如用 ctx.Err() 代替被包裹的 err）
- Data integrity risks
- Nil pointer dereference potential
- Dead code

OUTPUT: <verdict>PASS or FAIL</verdict> <findings>each with CRITICAL/MAJOR/MINOR severity, file:line reference, and concrete explanation</findings>
""")
```

### Agent 2: 安全 + 边界条件

```
task(subagent_type="oracle", load_skills=[], run_in_background=true,
  description="Review security of MODULE_NAME",
  prompt="""
<review_type>SECURITY + EDGE CASE REVIEW</review_type>
<module>{MODULE_NAME}</module>
<files>{FILE_LIST}</files>

通用要求:
R1. 时序场景模拟:
    - 识别模块中所有共享状态（全局变量、sync.Map、channel、atomic 操作等）
    - 列出每个共享状态的 所有读写操作 及其所在的函数/goroutine
    - 模拟 2-3 个 goroutine 交错时序，找出可能的竞态窗口
    - 特别关注"先释放某资源 → 其他 goroutine 获取 → 原 goroutine 再次操作该资源"的模式

R2. 逐 return 路径 cleanup 验证:
    - 对每个包含资源获取的函数，列出其所有 return 路径（正常结束、错误、超时、取消）
    - 逐路径验证 cleanup 完整性：每个 return 是否释放了该路径上已获取的所有资源
    - 比较对称路径的 cleanup 是否一致（如 if/else 分支、循环内 break vs continue vs return）

R3. 跨函数/跨文件共享状态生命周期追踪:
    - 如果一个共享状态的生命周期跨越多个函数/文件
    - 追踪该状态的完整路径，检查每个跳转点的一致性
    - 特别关注状态通过事件/参数传递时，中间件或错误路径是否会中断传递

R4. 隐式假设陷阱扫描:
    - 代码中的每个硬编码值（超时时长、重试次数/间隔、批大小、并发数、缓冲区容量、轮询频率）都隐含了一个对业务场景的假设。
      对这些假设逐条问:
      a) 这个值假定外部系统（AI API、DB、下游服务）的响应多快？负载多高？该假设在最坏情况下还成立吗？
      b) 这个值假定同时存在多少个并发操作？如果同时有 100 个而不是 1 个，还成立吗？
      c) 如果假设不成立，代码是"优雅退化"还是"直接中断"？中断后是否有补偿机制？
      d) 代码是否将"正常情况"和"边界情况"用了同一个值？
      e) 是否存在"读取时看起来安全，写入时暴露假设"的代码？
    - 除了硬编码值，还有一类更隐蔽的隐式假设——**代码结构本身隐含的对系统行为的假设**。对以下每类逐条排查:
      f) **事件/消息投递假设**: 是否假设"发布成功 = 一定被执行"？发布后的链路是否有超时/取消/panic 导致静默丢弃的路径？调用方的"成功日志"和实际执行之间有 gap 吗？
      g) **并发与 goroutine 模型假设**: 是否假设其他 goroutine 一定活着？是否假设 state 在读和写之间不变？是否假设信号量/buffer 永远不会满？
      h) **错误传播假设**: 是否用 `ctx.Err()` 代替了被包裹的底层 err？是否假设错误一定是某种特定类型？错误链路上是否有被吞没的中间错误？
      i) **key/标识符空间隔离假设**: 不同用途的 key（如 `game:<appID>` vs `game:batch:<hash>`）是否可能碰撞？token/ID 的生成方式是否保证全局唯一？
      j) **外部系统行为假设**: 是否假设外部 API 稳定返回特定格式？是否假设失败原因可被 binary split 重试解决？是否假设外部系统不会永久性失败？
      k) **defer 注册时序假设**: 所有资源释放（锁、token、channel close、连接归还等）的 defer 是否在 `ctx.Done()` 检查之前注册？如果 defer 注册在 ctx 检查之后，ctx 恰好在这两步之间取消时，defer 不会执行，资源永久泄漏。审阅每条 early‑return 路径：确认 defer 注册 → 确认 ctx 检查在 defer 之后。
      l) **契约边界假设**: 找出所有仅靠"当前代码路径唯一"维持的不变量（如单次订阅、单点初始化、单消费者语义）。对每个不变量，追问：如果路径倍增（重复订阅/重入/串跑/重启），系统是快速失败还是静默损坏？是否有恢复机制？是否存在调用方已假定"约束永远成立"但实现层没有任何防御的断裂点？
      m) **状态信息不完备假设**: 系统通过有限的状态信息（计数器、字段、信号量、缓存值）来代表真实世界。任何状态信息都可能因聚合粒度、传递损耗或更新延迟而与真实状态不符。对每个状态信息，追问：它在什么场景下会失准？失准时系统的行为是快速失败还是静默输出错误结果？

Review for:
- Input validation 的覆盖面和充分性
- Injection risks (SQL/命令/prompt injection 等)
- Secrets exposure (API key 是否被意外记入日志)
- DoS vectors（无界 goroutine、内存爆炸、死循环、无穷递归）
- 操作幂等性 vs 业务语义安全性的区别
  （例如：db.Delete 不报错 ≠ 业务语义正确；map.Delete 不 panic ≠ 没破坏其他持有者的状态）
- Edge cases: empty inputs, max-size, unicode, zero values, negative values, context cancelled during write
- Panic paths: 是否有未 recover 的 panic 点
- Resource leaks: HTTP body, goroutine, channel, semaphore
- Timeout handling: 内外层超时不匹配、超时后状态不一致
- 攻击者视角：假设调用者可以控制输入参数，找到所有利用路径

OUTPUT: <verdict>PASS or FAIL</verdict> <findings>each with CRITICAL/HIGH/MEDIUM/LOW severity, file:line reference, and concrete explanation</findings>
""")
```

### Agent 3: 架构 + 模式

```
task(subagent_type="oracle", load_skills=[], run_in_background=true,
  description="Review architecture of MODULE_NAME",
  prompt="""
<review_type>ARCHITECTURE + PATTERN REVIEW</review_type>
<module>{MODULE_NAME}</module>
<files>{FILE_LIST}</files>

通用要求:
R1. 时序场景模拟:
    - 识别模块中所有共享状态（全局变量、sync.Map、channel、atomic 操作等）
    - 列出每个共享状态的 所有读写操作 及其所在的函数/goroutine
    - 模拟 2-3 个 goroutine 交错时序，找出可能的竞态窗口
    - 特别关注"先释放某资源 → 其他 goroutine 获取 → 原 goroutine 再次操作该资源"的模式

R2. 逐 return 路径 cleanup 验证:
    - 对每个包含资源获取的函数，列出其所有 return 路径（正常结束、错误、超时、取消）
    - 逐路径验证 cleanup 完整性：每个 return 是否释放了该路径上已获取的所有资源
    - 比较对称路径的 cleanup 是否一致（如 if/else 分支、循环内 break vs continue vs return）

R3. 跨函数/跨文件共享状态生命周期追踪:
    - 如果一个共享状态的生命周期跨越多个函数/文件
    - 追踪该状态的完整路径，检查每个跳转点的一致性
    - 特别关注状态通过事件/参数传递时，中间件或错误路径是否会中断传递

R4. 隐式假设陷阱扫描:
    - 代码中的每个硬编码值（超时时长、重试次数/间隔、批大小、并发数、缓冲区容量、轮询频率）都隐含了一个对业务场景的假设。
      对这些假设逐条问:
      a) 这个值假定外部系统（AI API、DB、下游服务）的响应多快？负载多高？该假设在最坏情况下还成立吗？
      b) 这个值假定同时存在多少个并发操作？如果同时有 100 个而不是 1 个，还成立吗？
      c) 如果假设不成立，代码是"优雅退化"还是"直接中断"？中断后是否有补偿机制？
      d) 代码是否将"正常情况"和"边界情况"用了同一个值？
      e) 是否存在"读取时看起来安全，写入时暴露假设"的代码？
    - 除了硬编码值，还有一类更隐蔽的隐式假设——**代码结构本身隐含的对系统行为的假设**。对以下每类逐条排查:
      f) **事件/消息投递假设**: 是否假设"发布成功 = 一定被执行"？发布后的链路是否有超时/取消/panic 导致静默丢弃的路径？调用方的"成功日志"和实际执行之间有 gap 吗？
      g) **并发与 goroutine 模型假设**: 是否假设其他 goroutine 一定活着？是否假设 state 在读和写之间不变？是否假设信号量/buffer 永远不会满？
      h) **错误传播假设**: 是否用 `ctx.Err()` 代替了被包裹的底层 err？是否假设错误一定是某种特定类型？错误链路上是否有被吞没的中间错误？
      i) **key/标识符空间隔离假设**: 不同用途的 key（如 `game:<appID>` vs `game:batch:<hash>`）是否可能碰撞？token/ID 的生成方式是否保证全局唯一？
      j) **外部系统行为假设**: 是否假设外部 API 稳定返回特定格式？是否假设失败原因可被 binary split 重试解决？是否假设外部系统不会永久性失败？
      k) **defer 注册时序假设**: 所有资源释放（锁、token、channel close、连接归还等）的 defer 是否在 `ctx.Done()` 检查之前注册？如果 defer 注册在 ctx 检查之后，ctx 恰好在这两步之间取消时，defer 不会执行，资源永久泄漏。审阅每条 early‑return 路径：确认 defer 注册 → 确认 ctx 检查在 defer 之后。
      l) **契约边界假设**: 找出所有仅靠"当前代码路径唯一"维持的不变量（如单次订阅、单点初始化、单消费者语义）。对每个不变量，追问：如果路径倍增（重复订阅/重入/串跑/重启），系统是快速失败还是静默损坏？是否有恢复机制？是否存在调用方已假定"约束永远成立"但实现层没有任何防御的断裂点？
      m) **状态信息不完备假设**: 系统通过有限的状态信息（计数器、字段、信号量、缓存值）来代表真实世界。任何状态信息都可能因聚合粒度、传递损耗或更新延迟而与真实状态不符。对每个状态信息，追问：它在什么场景下会失准？失准时系统的行为是快速失败还是静默输出错误结果？

Review for:
- Package structure: 依赖方向是否清晰，是否存在循环依赖
- 对称性检查: 是否有类似的代码路径（如 A vs B、game vs price、producer vs consumer）
  它们的 cleanup/错误处理是否一致？不一致的差异是否有正当理由？
- 代码重复: 哪些可以抽象复用，哪些是必要差异
- Over-engineering: 是否存在不必要复杂度
- Dead code: 未使用的函数、类型、字段、常量
- 常量组织: 分散或重复的常量、硬编码值
- Interface design: 是否利于测试（mockable）、扩展
- 全局状态依赖: 是否过度依赖全局变量，影响可测试性和并发安全性
- 已知设计约束记录: 如无法避免的依赖倒置，标注为已知约束

OUTPUT: <verdict>PASS or FAIL</verdict> <findings>each with CRITICAL/MAJOR/MINOR severity, file:line reference, and concrete explanation</findings>
""")
```

### Agent 4: 攻击者测试

这是新增角色，专门从"破坏系统"角度审查。它不检查"代码好不好看"，只检查"有什么方式能让系统坏掉"。

```
task(subagent_type="oracle", load_skills=[], run_in_background=true,
  description="Adversarial review of MODULE_NAME",
  prompt="""
<review_type>ADVERSARIAL + DESTRUCTIVE TESTING</review_type>
<module>{MODULE_NAME}</module>
<files>{FILE_LIST}</files>

角色: 你是恶意攻击者/系统破坏者。你的目标是找到所有方式让这个模块出错、崩溃、数据损坏、或行为异常。
你不关心代码风格或架构优雅性。只关心：**我怎么搞坏它？**

通用要求:
R1. 时序场景模拟:
    - 识别模块中所有共享状态（全局变量、sync.Map、channel、atomic 操作等）
    - 列出每个共享状态的 所有读写操作 及其所在的函数/goroutine
    - 模拟 2-3 个 goroutine 交错时序，找出可能的竞态窗口
    - 特别关注"先释放某资源 → 其他 goroutine 获取 → 原 goroutine 再次操作该资源"的模式

R2. 逐 return 路径 cleanup 验证:
    - 对每个包含资源获取的函数，列出其所有 return 路径（正常结束、错误、超时、取消）
    - 逐路径验证 cleanup 完整性：每个 return 是否释放了该路径上已获取的所有资源
    - 比较对称路径的 cleanup 是否一致（如 if/else 分支、循环内 break vs continue vs return）

R3. 跨函数/跨文件共享状态生命周期追踪:
    - 如果一个共享状态的生命周期跨越多个函数/文件
    - 追踪该状态的完整路径，检查每个跳转点的一致性
    - 特别关注状态通过事件/参数传递时，中间件或错误路径是否会中断传递

R4. 隐式假设陷阱扫描:
    - 代码中的每个硬编码值（超时时长、重试次数/间隔、批大小、并发数、缓冲区容量、轮询频率）都隐含了一个对业务场景的假设。
      对这些假设逐条问:
      a) 这个值假定外部系统（AI API、DB、下游服务）的响应多快？负载多高？该假设在最坏情况下还成立吗？
      b) 这个值假定同时存在多少个并发操作？如果同时有 100 个而不是 1 个，还成立吗？
      c) 如果假设不成立，代码是"优雅退化"还是"直接中断"？中断后是否有补偿机制？
      d) 代码是否将"正常情况"和"边界情况"用了同一个值？
      e) 是否存在"读取时看起来安全，写入时暴露假设"的代码？
    - 除了硬编码值，还有一类更隐蔽的隐式假设——**代码结构本身隐含的对系统行为的假设**。对以下每类逐条排查:
      f) **事件/消息投递假设**: 是否假设"发布成功 = 一定被执行"？发布后的链路是否有超时/取消/panic 导致静默丢弃的路径？调用方的"成功日志"和实际执行之间有 gap 吗？
      g) **并发与 goroutine 模型假设**: 是否假设其他 goroutine 一定活着？是否假设 state 在读和写之间不变？是否假设信号量/buffer 永远不会满？
      h) **错误传播假设**: 是否用 `ctx.Err()` 代替了被包裹的底层 err？是否假设错误一定是某种特定类型？错误链路上是否有被吞没的中间错误？
      i) **key/标识符空间隔离假设**: 不同用途的 key（如 `game:<appID>` vs `game:batch:<hash>`）是否可能碰撞？token/ID 的生成方式是否保证全局唯一？
      j) **外部系统行为假设**: 是否假设外部 API 稳定返回特定格式？是否假设失败原因可被 binary split 重试解决？是否假设外部系统不会永久性失败？
      k) **defer 注册时序假设**: 所有资源释放（锁、token、channel close、连接归还等）的 defer 是否在 `ctx.Done()` 检查之前注册？如果 defer 注册在 ctx 检查之后，ctx 恰好在这两步之间取消时，defer 不会执行，资源永久泄漏。审阅每条 early‑return 路径：确认 defer 注册 → 确认 ctx 检查在 defer 之后。
      l) **契约边界假设**: 找出所有仅靠"当前代码路径唯一"维持的不变量（如单次订阅、单点初始化、单消费者语义）。对每个不变量，追问：如果路径倍增（重复订阅/重入/串跑/重启），系统是快速失败还是静默损坏？是否有恢复机制？是否存在调用方已假定"约束永远成立"但实现层没有任何防御的断裂点？
      m) **状态信息不完备假设**: 系统通过有限的状态信息（计数器、字段、信号量、缓存值）来代表真实世界。任何状态信息都可能因聚合粒度、传递损耗或更新延迟而与真实状态不符。对每个状态信息，追问：它在什么场景下会失准？失准时系统的行为是快速失败还是静默输出错误结果？

找以下类别的破坏路径（每个类别给出具体时序）:

1. 并发破坏:
   - 双释放：同一个资源被释放两次，第二次释放时已被其他人持有
   - 释放后使用：资源被释放后仍有代码路径访问它
   - 先读后写竞态：TOC/TOU (time-of-check vs time-of-use)
   - 死锁/活锁/自旋：循环等待条件永远不满足
   - 优先级反转：高优先级任务被低优先级任务阻塞超过预期
   - ABA 问题：atomic.CompareAndSwap 的经典陷阱

2. 状态泄露:
   - Defer/resource 泄露：某个 return 路径遗漏了资源释放
   - 对称性违反：A 路径有 cleanup，B 路径没有
   - 永久残留：某个 key/token 写入 map 后没有删除路径

3. 数据损坏:
   - 并发写入同一条记录
   - 部分更新：一批操作中部分成功部分失败
   - 脏读：读到不完整的状态

4. 静默失败:
   - 错误被 log 后继续执行（错误被吞没）
   - 返回成功但实际未执行任何操作
   - 条件竞争导致跳过执行

5. 超时/取消不一致:
   - 外层超时比内层短，导致内层操作被无故终止
   - 取消后状态未回滚
   - 超时后仍有 goroutine 在后台运行

OUTPUT: <verdict>PASS or FAIL</verdict> <findings>each with CRITICAL/HIGH/MEDIUM/LOW severity, file:line reference, concrete exploit scenario, and expected impact</findings>
""")
```

## 交叉验证

所有 Agent 返回 findings 后，Sisyphus 执行交叉验证：

```
交叉验证步骤:

1. 收集 4 个 Agent 的所有 findings，去重合并

2. 让 Agent 4 审查 Agent 1-3 的 findings:
   - 是否有 Agent 1-3 判定为 PASS 但 Agent 4 持怀疑态度的？
   - 是否有 Agent 1-3 标记为 MINOR 但 Agent 4 认为可能是 MAJOR/CRITICAL 的？
   - 输出: 补充遗漏、严重度修正建议

3. 让 Agent 1-3 审查 Agent 4 的 findings:
   - 是否与 Agent 1-3 的已有发现重叠？
   - 是否有 Agent 4 发现但其他 Agent 确实遗漏的关键问题？
   - 输出: 去重后的新增 findings

4. Sisyphus 逐条检查 findings 的判定质量（误判检测）:
   - 对每条 finding，检查是否有 Agent 给出了"底层操作安全，无实际 bug"类判定
   - 追问：该操作在 业务语义 上是否安全？（即是否可能破坏其他 goroutine 的状态）
   - 如果发现误判 → 标注 MISJUDGMENT，该轮 G6 门禁 FAIL
```

交叉验证的输出格式：
```
<cross_validation>
  <agent4_supplements>
    <finding ref="agent3_finding_5">严重度从 MINOR 修正为 MAJOR: ...</finding>
    <finding ref="new">Agent 1-3 未发现的路径: ...</finding>
  </agent4_supplements>
  <agent1_3_review>
    <finding ref="agent4_finding_3">与 agent1_finding_7 重复，合并</finding>
    <finding ref="agent4_finding_8">确认遗漏，补充到主清单</finding>
  </agent1_3_review>
  <misjudgment_check>
    <finding ref="agent1_finding_2" verdict="MISJUDGMENT">
      原判定: "sync.Map.Delete 幂等安全，无实际 bug"
      纠正: 虽然 Delete 不 panic，但此时 map 中存的是其他 goroutine 的 token，删除它导致该 goroutine 状态泄露
    </finding>
  </misjudgment_check>
</cross_validation>
```

## 修复 Agent 分流规则

| 问题规模 | Agent | 策略 |
|----------|-------|------|
| 单文件简单修改 | `category="quick"` | 逐一给出文件路径+行号+精确修改内容 |
| 多文件协调修改 | `category="quick"` 分批 | 按「修改的文件不重叠」原则并行 |
| 复杂逻辑重写 | `category="deep"` | 给出完整上下文和期望结果 |

## 退出条件

循环终止条件（按优先级）：

| 优先级 | 条件 | 说明 |
|--------|------|------|
| 1 | **全部质量门禁通过** | 正常退出 — 质量达标 |
| 2 | **用户手动终止** | `stop` / `终止` / `暂停` |
| 3 | **僵局经用户决策终止** | 上报后用户选择「接受现状」或「改方案」 |

**不存在「无新发现就自动停止」这条退路。** 只要门禁没全过，就继续循环。
只有质量达标、用户叫停、或用户决策接受现状这三种情况才能终止。

## 最终报告模板

```markdown
# {MODULE_NAME} 自评审报告

## 总览
- 模块: {MODULE_NAME}
- 发现模式: [包路径 / 功能模块探索 / 手动指定]
- 涉及包/服务: {PACKAGES / SERVICES}
- 轮次: {ROUNDS}
- 最终判定: PASS / FAIL
- 已修复: {FIXED_COUNT} 项
- 已知设计约束: {CONSTRAINT_COUNT} 项
- 审查 Agent: 4 个（正确性/安全+边界/架构+模式/攻击者测试）
- 交叉验证: [已执行 / 跳过]
- 误判检测: [无误判 / 发现 {N} 条误判并纠正]

## 已修复问题
| # | 严重度 | 描述 | 文件 | 修复方式 |
|---|--------|------|------|----------|

## 误判纠正记录
| # | 原判定 | 纠正后 | 描述 |
|---|--------|--------|------|

## 已知设计约束
| # | 描述 | 原因 |
|---|------|------|

## 验证
- build: {STATUS}
- test: {PASSED}/{TOTAL}
```
