# Worker 可靠执行实施记录

实施日期为 2026-11-26，对应 [核心架构重构实施计划](./MatrixArk-核心架构重构实施计划.md) 的第三阶段（Worker 独立模块化、有界并发、租约心跳续期与队列积压监控）。

## 基线与前置阶段核查

开始第三阶段前，先核查第一、二阶段交付状态：
- 第一阶段已按 [核心业务解耦实施记录](./核心业务解耦实施记录.md) 与 [方法迁移清单](./tasks-service-method-inventory.md) 落地（`TasksService` Facade、`application/`、`dispatch/`、`domain/`、`infrastructure/` 与统一状态迁移）。
- 第二阶段已按 [平台适配插件化实施记录](./平台适配插件化实施记录.md) 落地（`AdapterRegistry`、内容策略、账号能力解析与 `PublishingPlatform` 运行时）。
- 基线 `pnpm typecheck`、`pnpm test` 与 `select-targets` / `platform-policies` 单元测试均全部通过，随后进入第三阶段开发。

## 交付内容

### 1. 运行时与 HTTP Controller 彻底解耦（`WorkerModule`）
- 提取无 Controller 的纯运行时模块：
  - [notifications-runtime.module.ts](file:///D:/MatrixArk/apps/api/src/notifications/notifications-runtime.module.ts)
  - [accounts-runtime.module.ts](file:///D:/MatrixArk/apps/api/src/accounts/accounts-runtime.module.ts)
  - [content-runtime.module.ts](file:///D:/MatrixArk/apps/api/src/content/content-runtime.module.ts)
  - [tasks-runtime.module.ts](file:///D:/MatrixArk/apps/api/src/tasks/tasks-runtime.module.ts)
- 原 HTTP 业务模块（`NotificationsModule`、`AccountsModule`、`ContentModule`、`TasksModule`）继续保留全部 Controller、Facade 与导出，保障既有集成测试及 Web/API 调用无缝兼容。
- 新增 [worker.module.ts](file:///D:/MatrixArk/apps/api/src/worker/worker.module.ts) 并更新 [worker.ts](file:///D:/MatrixArk/apps/api/src/worker.ts)，使后台 Worker 启动不再加载任何 HTTP Controller，通过 [worker-runner.service.ts](file:///D:/MatrixArk/apps/api/src/worker/worker-runner.service.ts) 协调全部轮询任务与优雅停机。

### 2. 有界并发（Bounded Concurrency）与单账号互斥
- 新增 [concurrency.ts](file:///D:/MatrixArk/apps/api/src/worker/concurrency.ts)（`runBounded`），按有界工作池并发上限执行异步任务。
- [config.ts](file:///D:/MatrixArk/apps/api/src/config.ts) 新增 `config.worker` 可调参数：`dispatchConcurrency`（默认 4，范围 1–16）、`receiptConcurrency`（默认 4）、`metricsConcurrency`（默认 2）、租约与续期周期、心跳与积压预警阈值。
- [task-dispatch.service.ts](file:///D:/MatrixArk/apps/api/src/tasks/dispatch/task-dispatch.service.ts) 在保持数据库逐个事务领取与单账号互斥索引的基础上，将跨账号的自动投稿并发限制在有界工作池内执行；[task-receipt.service.ts](file:///D:/MatrixArk/apps/api/src/tasks/dispatch/task-receipt.service.ts) 与 [task-metrics.service.ts](file:///D:/MatrixArk/apps/api/src/tasks/application/task-metrics.service.ts) 同步接入 `runBounded`。
- 自动通道改为「先占执行位再领取」：每轮只领取不超过 `dispatchConcurrency` 个自动任务并立即提交，避免任务领取后排队等待导致租约在提交前过期、被提交前检查记成「需核实」；人工交接仍在同一次事务里完成。

### 3. 租约心跳续期（Lease Heartbeat Renewal）
- [task-lease.service.ts](file:///D:/MatrixArk/apps/api/src/tasks/dispatch/task-lease.service.ts) 新增 `renewLease(workspaceId, taskId, leaseId, extendMs)`，仅在 `status = 'dispatching'`、`leaseId` 匹配且尚未过期时原子顺延 `leaseExpiresAt`，不改变任务状态或恢复已超时的租约。
- [task-claim.service.ts](file:///D:/MatrixArk/apps/api/src/tasks/dispatch/task-claim.service.ts) 使用可配置租约时长；[task-executor.service.ts](file:///D:/MatrixArk/apps/api/src/tasks/dispatch/task-executor.service.ts) 在外部请求期间周期性触发 `renewLease` 并在 `finally` 清理定时器，避免耗时较长的上传在 Worker 存活期间被误判超时。

### 4. Worker 心跳落库与队列积压监控
- Schema 迁移 [202611260003_worker_heartbeats/migration.sql](file:///D:/MatrixArk/apps/api/prisma/migrations/202611260003_worker_heartbeats/migration.sql) 新增 `WorkerStatus`（`running` / `draining` / `stopped`）与 `WorkerHeartbeat` 表（全部时间字段使用 `timestamptz(3)`），并在 [app-privileges.sql](file:///D:/MatrixArk/apps/api/prisma/app-privileges.sql) 为 `matrixark_app` 授予 `SELECT, INSERT, UPDATE`。
- 新增 [worker-heartbeat.service.ts](file:///D:/MatrixArk/apps/api/src/worker/worker-heartbeat.service.ts) 与 [worker-monitor.service.ts](file:///D:/MatrixArk/apps/api/src/worker/worker-monitor.service.ts)（通过 [worker-monitor.module.ts](file:///D:/MatrixArk/apps/api/src/worker/worker-monitor.module.ts) 供 Worker 与 API 共用）。
- [health.controller.ts](file:///D:/MatrixArk/apps/api/src/health.controller.ts) 保持 `GET /api/health` 返回 `{ ok: true }`；监控接口收口至工作室隔离的 `GET /api/workspaces/:workspaceId/worker-health`（[workspaces.controller.ts](file:///D:/MatrixArk/apps/api/src/workspaces/workspaces.controller.ts)），通过权限动作 `worker:monitor` 限制仅负责人（`owner`）与运营（`operator`）可查看，输出在线/失联 Worker 心跳状态、各轮询环节耗时与异常统计，以及当前工作室队列积压指标；并在工作台前端新增受角色控制的 [worker-monitor.tsx](file:///D:/MatrixArk/apps/web/app/worker-monitor.tsx)「运行监控」页面。
- [infra/ci/select-targets.mjs](file:///D:/MatrixArk/infra/ci/select-targets.mjs)、[infra/ci/check-database.sh](file:///D:/MatrixArk/infra/ci/check-database.sh) 与 [.github/workflows/matrixark.yml](file:///D:/MatrixArk/.github/workflows/matrixark.yml) 同步纳管 `apps/api/src/worker/`、`WorkerHeartbeat` 权限校验和 `worker-concurrency.test.mjs`。

## 验证结果

| 命令或检查 | 结果 |
| --- | --- |
| `pnpm db:generate` | 通过 |
| `pnpm build`（4 个工作区包） | 通过 |
| `pnpm typecheck`（4 个工作区包） | 通过 |
| `pnpm test` | Shared 30 项 + Adapters 4 项全部通过 |
| `node --test infra/ci/select-targets.test.mjs apps/api/test/platform-policies.test.mjs apps/api/test/worker-concurrency.test.mjs` | 5 项全部通过（覆盖 `runBounded`、`WorkerModule` 无任何 Controller 与 CI 路径判断） |
| PostgreSQL 全量升级验证（`matrixark_upgrade_test` 从 `0000_init` 升级全部 22 个迁移 + `app-privileges.sql`） | 全部通过，`WorkerHeartbeat` 权限与 `timestamptz` 检查通过 |
| `node --test --test-concurrency=1 apps/api/test/variant-snapshot.test.mjs apps/api/test/manual-handoff.test.mjs` | 26 / 26 全部通过（含新增 `WorkerModule 独立启动、有界并发、租约心跳续期与积压监控`） |
| 本地开发库 `postgres` `migrate deploy` 与 `app-privileges.sql` | 已同步应用至 `202611260003_worker_heartbeats` |
