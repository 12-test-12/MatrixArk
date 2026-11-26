# TasksService 方法迁移清单

核对日期为 2026-11-26。基线为 `aae6287` 加本轮开始前的工作区改动，包含排期抖动、验证码熔断和账号环境检查。原服务为 1115 行，包含 16 个公开异步方法和 17 个私有方法。

## 公开方法与调用方

所有公开方法由原路径的 `TasksService` 代理，继续沿用原参数、可选参数、返回值及异常语义。`WorkMetrics` 与 `WorkMetricsInput` 继续从原路径导出。

| 方法 | 目标服务 | Controller | Worker | 其他调用方 | 事务与持久化 | 平台调用 | 状态与事件 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| schedule | TaskCommandService | 是 | 否 | TrialWorkspaceService | 可接收外部事务，批量创建任务 | 本地平台字段校验 | 创建任务与 created 事件 |
| changeSchedule | TaskCommandService | 是 | 否 | 无 | 自有事务，锁原稿、版本、账号、任务 | 应用凭据读取 | 改期、恢复、重试及事件 |
| cancel | TaskCommandService | 是 | 否 | 无 | 自有事务，锁任务 | 无 | 取消任务、跳过提醒及事件 |
| verify | TaskCommandService | 是 | 否 | 无 | 自有事务，锁任务 | 无 | 核实与结果事件 |
| list | TaskQueryService | 是 | 否 | 无 | 只读查询 | 无 | 无 |
| detail | TaskQueryService | 是 | 否 | 无 | 只读查询 | 无 | 读取事件与提醒记录 |
| handoff | TaskEvidenceService | 是 | 否 | 无 | 只读查询 | 无 | 校验并读取已审交接包 |
| readEvidence | TaskEvidenceService | 是 | 否 | 无 | 只读查询与存储读取 | 无 | 无 |
| attachEvidence | TaskEvidenceService | 是 | 否 | 无 | 存储保存后事务登记，失败检查与清理 | 无 | 登记本任务证据 |
| recordResult | TaskCommandService | 是 | 否 | 无 | 自有事务，锁任务 | 无 | 回填、更正、跳过提醒及事件 |
| saveMetrics | TaskMetricsService | 是 | 否 | syncMetrics | 自有事务，锁任务，写采集快照与最新指标 | 无 | 无任务状态变化 |
| metricHistory | TaskMetricsService | 是 | 否 | 无 | 只读查询 | 无 | 无 |
| syncMetrics | TaskMetricsService | 是 | 否 | syncDueArticleMetrics | 事务外采集，再调用 saveMetrics | B 站成效接口 | 无任务状态变化 |
| syncDueArticleMetrics | TaskMetricsService | 否 | 是 | 无 | 条件更新采集尝试时间 | 通过 syncMetrics 调用 | 无任务状态变化 |
| dispatchDue | TaskDispatchService | 否 | 是 | 无 | 编排恢复、候选扫描、领取和执行 | 通过 Executor 调用 | 由领取与回执服务处理 |
| pollAutomaticResults | TaskReceiptService | 否 | 是 | 无 | 条件更新时间，事务外回读，再锁任务保存 | 平台状态接口 | 结果与事件 |

API 入口仍为 `tasks.controller.ts`。Worker 入口仍为 `worker.ts`。试用工作室继续在其现有事务内调用 `schedule`。集成测试继续通过原 Facade 验证 API 与 Worker 并发执行。

## 原私有方法归属

| 原方法 | 当前归属 |
| --- | --- |
| requireAvailableAccount | infrastructure/TaskPlatformService |
| hasLateAcceptance | infrastructure/task-locks.ts 中的共享查询函数 |
| requireNoAcceptance | application/TaskCommandService |
| accountPerformanceSummary | application/TaskQueryService |
| performanceSummary | application/TaskQueryService |
| requireEvidenceWrite | application/TaskEvidenceService |
| validateEvidence | application/TaskEvidenceService，供命令服务在当前事务内调用 |
| skipPendingReminders | application/TaskCommandService |
| requireHandoff | domain/task-policy.ts 中的共享规则 |
| claim | dispatch/TaskClaimService |
| submitClaim | dispatch/TaskExecutorService |
| isCaptchaCircuitBreak | dispatch/TaskExecutorService |
| circuitBreakToManual | dispatch/TaskExecutorService |
| readPublishImages | infrastructure/TaskPlatformService |
| recoverExpiredClaims | dispatch/TaskLeaseService |
| receiptDetails | domain/task-policy.ts 中的共享回执转换 |
| storeAutomaticResult | dispatch/TaskReceiptService，接收当前事务 |

## 状态写入与锁边界

- 单任务状态变化经过 `domain/task-transition.ts` 的 `transitionTask`，更新条件包含任务 ID、工作室和读取到的状态，状态相关字段与对应事件在同一事务内保存。
- `scheduled → scheduled` 只允许用于改期事件。核实后继续保存结果时，在同一事务内执行 `unknown/failed → verified → submitted/published`，保留原有两条事件及其顺序。
- 内容归档和版本取代使用同文件的 `pauseScheduledTasks`，批量更新仍处于 `scheduled` 的任务，并只为实际更新的记录创建事件。
- 首次排期保留批量创建任务与 created 事件。指标采集时间、回读时间更新沿用原有条件更新。
- 排期和领取按原稿、版本、账号、任务的原有顺序加锁，同表多行按 ID 排序。取消、证据、回填、回执和租约恢复保留任务锁。
- 领取租约仍为 90 秒。Worker 保留每轮最多 50 个派发候选、串行提交，以及原有回读、成效、通知和巡检频率。
- 平台 HTTP 请求在数据库事务外执行。人工交接适配器只生成本地回执，继续与领取在同一事务提交。
- `ContentService` 直接引用无 NestJS Provider 依赖的迁移函数，避免内容模块反向依赖任务模块。
