# MatrixArk 核心架构重构实施计划

> **文档版本：** v1.1  
> **编写日期：** 2026-11-26  
> **适用仓库：**
> [12-test-12/MatrixArk](https://github.com/12-test-12/MatrixArk)  
> **参考项目：**
> [3441293738/creatorhub](https://github.com/3441293738/creatorhub)  
> **本轮范围：** 第一阶段------核心业务解耦，重点拆分 `TasksService`  
> **实施原则：** 保持现有业务行为、API
> 契约和数据库结构不变，先重构内部职责，再推进 Adapter 和 Worker 改造。

第一阶段已按当前工作区完成实现。方法和调用方见 [方法迁移清单](./tasks-service-method-inventory.md)，事务边界、验证结果、行为修正和回退范围见 [实施记录](./核心业务解耦实施记录.md)。下文的目录和代码示例保留为设计参考，实际实现以这两份记录及源码为准。

第二阶段已完成注册表、内容策略、账号能力解析和平台运行时接入，变更及验证结果见 [平台适配插件化实施记录](./平台适配插件化实施记录.md)。

第三阶段已完成 `WorkerModule` 独立模块化、有界并发执行、租约心跳续期、Worker 存活心跳与队列积压监控，详见 [Worker可靠执行实施记录](./Worker可靠执行实施记录.md)。

---

## 1. 项目背景与本轮目标

MatrixArk 已经具备一套较完整的业务基础，包括：

- Workspace、成员角色和工作室数据隔离；
- Manuscript、Variant、Approval 等内容与审核模型；
- 内容版本快照、内容哈希和版本取代机制；
- PublishTask、PublishResult、TaskEvent 等发布任务模型；
- 任务幂等键、数据库行锁、领取租约和过期恢复；
- 独立 Worker 进程；
- `packages/adapters` 中的平台适配接口；
- B 站官方专栏发布通道，以及小红书人工交接通道。

当前阶段不应推翻这些已有设计。真正需要解决的是：部分服务承担了过多职责，任务状态修改入口分散，平台专属逻辑仍然渗透在核心任务服务中，Worker
与业务模块的依赖边界也有进一步整理空间。

### 1.1 本轮必须达成的目标

1. 将 `TasksService`
  拆分为命令、查询、交接证据、成效同步和任务派发等职责明确的服务。
2. 保留原有 `TasksService` 作为 Facade，尽量不修改
  Controller、路由和前端调用。
3. 建立统一的任务状态迁移入口，逐步消除业务模块直接修改任务状态的情况。
4. 梳理数据库事务、行锁、幂等和租约边界，确保重构不破坏现有并发安全性。
5. 将 B 站专属代码从通用任务编排中逐步迁出，为下一阶段 Adapter Registry
  做准备。
6. 补齐与重构范围相关的自动化测试和 CI 触发条件。

### 1.2 本轮明确不做的事情

为控制风险，第一阶段不做以下改动：

- 不重写 Next.js 前端；
- 不修改现有 HTTP 路由、请求参数和响应结构；
- 不修改 Prisma Schema，不新增数据库迁移；
- 不引入 Redis、BullMQ、Kafka 或 RabbitMQ；
- 不在本轮实现多平台自动发布；
- 不在本轮改变任务并发策略；
- 不将 B 站发布逻辑整体重写；
- 不将项目拆成微服务；
- 不因为目录调整而批量改名业务状态或数据库字段。

**第一阶段的验收重点是"内部职责拆开，但用户看到的功能和行为不变"。**

---

## 2. 当前架构问题与改造判断

以下判断基于此前对 MatrixArk
仓库源码和项目文档的检查。实际开始开发时，应先对照当前分支重新确认文件、函数和脚本名称，不能直接假设本地工作树与检查时完全一致。

### 2.1 `TasksService` 职责集中

目前 `apps/api/src/tasks/tasks.service.ts` 承担了多类工作：

---

  职责                    典型方法/逻辑                            目标归属

---

  创建和修改任务          `schedule`、`changeSchedule`             TaskCommandService

  取消、核实任务          `cancel`、`verify`、结果回填             TaskCommandService

  任务列表和详情          `list`、`detail`                         TaskQueryService

  人工交接与证据          `handoff`、证据读取/附件                 TaskEvidenceService

  成效数据                `saveMetrics`、`syncMetrics`、历史趋势   TaskMetricsService

  到期任务派发            `dispatchDue`                            TaskDispatchService

  领取与执行              `claim`、`submitClaim`                   TaskClaimService /
                                                                   TaskExecutorService

  租约恢复                `recoverExpiredClaims`                   TaskLeaseService

## 自动结果回读            `pollAutomaticResults`                   TaskReceiptService

迁移时应以当前文件中的真实公开方法为准，先做完整方法清单，再逐个迁移。不能因为表格没有列出某个方法就删除或遗漏它。

### 2.2 状态写入规则分散

`packages/shared/src/status.ts`
已经提供任务状态相关规则，但内容模块中存在直接批量更新
`PublishTask.status` 并写入 `TaskEvent` 的逻辑。

例如，稿件归档或版本被取代时，需要暂停仍处于 `scheduled`
状态的任务。此逻辑目前在内容服务中执行。

问题不是这段代码必然错误，而是任务状态的业务规则分散在多个模块。后续增加状态、审计和恢复规则时，容易出现不同入口执行不同校验的情况。

### 2.3 平台专属逻辑仍然进入任务核心

当前 Adapter 已经抽象了 `preflight`、`publish`、`fetchStatus`
等能力，但任务服务仍然引用 B 站专属 Adapter、B 站内容校验或 B
站应用配置。

第一阶段只需要把平台相关依赖整理成清晰边界，不要在拆分 `TasksService`
时顺便重写全部 Adapter。真正的 Adapter Registry 放在第二阶段完成。

### 2.4 Worker 与任务模块耦合

当前 Worker 通过 NestJS Application Context
加载任务模块。任务模块同时注册了 Controller 和业务服务。

`createApplicationContext()` 不会启动 HTTP 监听，因此这并不代表 Worker
启动了 API 服务；但从模块边界看，后台进程不应长期依赖包含 HTTP
Controller 的完整功能模块。

Worker 独立模块化属于后续阶段。本轮先确保任务执行服务可以被 Worker
调用，不要在同一个 PR 中同时重构 Worker 启动入口。

### 2.5 事务与锁的边界必须保留

目前任务系统依赖 PostgreSQL
事务、行锁、幂等键和租约。重构不能只关注代码文件变短，还必须保持以下原则：

- 数据库状态变更与对应 `TaskEvent` 在同一事务内提交；
- 平台 HTTP 请求不放在数据库事务内；
- 领取任务、提交回执和租约恢复仍然执行原有校验；
- 旧租约产生的迟到回执不能覆盖新任务状态；
- 不能因为拆服务而改变原有锁定顺序；
- 不同 Workspace 的数据隔离条件不能丢失。

---

## 3. 目标目录结构

第一阶段建议在现有 `tasks`
目录内逐步增加子目录，不要求立即迁移整个仓库。

```text
apps/api/src/tasks/
├── tasks.controller.ts
├── tasks.module.ts
├── tasks.service.ts                 # 保留为 Facade
│
├── application/
│   ├── task-command.service.ts      # 创建、修改、取消、核实
│   ├── task-query.service.ts        # 列表、详情、汇总查询
│   ├── task-evidence.service.ts     # 人工交接、证据读取与附件
│   └── task-metrics.service.ts      # 指标记录、同步和历史数据
│
├── domain/
│   ├── task-transition.ts           # 任务状态迁移规则
│   ├── task-policy.ts                # 任务领域规则
│   ├── task.types.ts                 # 任务领域类型
│   └── task.errors.ts                # 领域错误（按需）
│
├── dispatch/
│   ├── task-dispatch.service.ts      # 到期任务扫描和派发编排
│   ├── task-claim.service.ts         # 原子领取、租约创建
│   ├── task-executor.service.ts      # 调用 Adapter 执行
│   ├── task-lease.service.ts         # 租约续期、过期恢复
│   └── task-receipt.service.ts       # 平台回执和状态回读
│
└── infrastructure/
    ├── task-locks.ts                 # 锁定辅助方法
    ├── task.repository.ts            # 仅在确有复用价值时引入
    └── task-event.repository.ts      # 仅在确有复用价值时引入
```

### 3.1 目录职责约束

---

  目录                    可以做什么                         不应该做什么

---

  `application`           编排用户发起的业务用例             直接承载所有平台 HTTP 细节

  `domain`                状态迁移、领域规则、纯函数校验     依赖 NestJS Controller
                                                             或网络请求

  `dispatch`              后台派发、领取、执行、租约和回执   处理 Web 页面展示逻辑

  `infrastructure`        数据库锁、持久化和技术实现         自行决定业务是否允许迁移状态

## `tasks.service.ts`      兼容旧调用方，转发到新服务         再次积累完整业务实现

不要为了目录完整而创建大量空文件。只有在真实迁移某项职责时才创建对应文件。

---

## 4. 方法迁移清单

开始改造前，先对当前 `TasksService` 做一次完整盘点。

### 4.1 建立方法清单

在仓库根目录执行：

```bash
rg -n "^[[:space:]]*(async[[:space:]]+)?[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*\\(" \
  apps/api/src/tasks/tasks.service.ts
```

同时搜索所有调用方：

```bash
rg -n "tasksService\\.|TasksService" apps/api/src
```

将结果整理为清单，至少记录：

- 方法名称；
- 是否被 Controller 调用；
- 是否被 Worker 调用；
- 是否被其他 Service 调用；
- 是否有事务参数；
- 是否直接访问 Prisma；
- 是否调用平台 Adapter；
- 是否修改任务状态；
- 是否写入 `TaskEvent`。

### 4.2 推荐迁移映射

---

  原有方法/功能             新服务                  迁移要求

---

  `schedule`                TaskCommandService      保留账号、版本、权限、幂等和排期校验

  `changeSchedule`          TaskCommandService      保留改期、重试和状态限制

  `cancel`                  TaskCommandService      保留取消原因、操作者和审计事件

  `verify`                  TaskCommandService      保留待核实状态及核实结果规则

  结果记录/更正             TaskCommandService      保留原有证据、结果和事件关联

  `list`                    TaskQueryService        保留 Workspace 过滤、分页和排序

  `detail`                  TaskQueryService        保留详情中的关联数据和权限过滤

  `handoff`                 TaskEvidenceService     保留人工交接时间和事件写入

  证据读取/附件             TaskEvidenceService     保留文件归属和访问权限检查

  `saveMetrics`             TaskMetricsService      保留指标来源、操作者和采集时间

  `syncMetrics`             TaskMetricsService      保留重复触发保护和平台错误处理

  `syncDueArticleMetrics`   TaskMetricsService      保留到期筛选和同步窗口

  `dispatchDue`             TaskDispatchService     先保持原派发行为，不在本轮增加并发

  `claim`                   TaskClaimService        保留事务、锁、租约和幂等判断

  `submitClaim`             TaskExecutorService     保留 Adapter 前置检查、发布和回执处理

  `recoverExpiredClaims`    TaskLeaseService        保留租约校验、过期恢复和待核实语义

## `pollAutomaticResults`    TaskReceiptService      保留状态回读与回执幂等

如果当前分支中的方法名称不同，以实际源码为准。一个方法内部如果混合了多个职责，可以先整体迁移，再在后续小提交中拆开，避免一次重构同时改变业务逻辑。

---

## 5. Facade 设计：保持外部调用兼容

`TasksService` 应保留在原路径，避免 Controller 和 Worker
在第一阶段大量修改。

示例结构：

```typescript
import { Injectable } from '@nestjs/common';

import { TaskCommandService } from './application/task-command.service';
import { TaskQueryService } from './application/task-query.service';
import { TaskEvidenceService } from './application/task-evidence.service';
import { TaskMetricsService } from './application/task-metrics.service';
import { TaskDispatchService } from './dispatch/task-dispatch.service';
import { TaskReceiptService } from './dispatch/task-receipt.service';

@Injectable()
export class TasksService {
  constructor(
    private readonly commands: TaskCommandService,
    private readonly queries: TaskQueryService,
    private readonly evidence: TaskEvidenceService,
    private readonly metrics: TaskMetricsService,
    private readonly dispatcher: TaskDispatchService,
    private readonly receipts: TaskReceiptService,
  ) {}

  schedule(...args: Parameters<TaskCommandService['schedule']>) {
    return this.commands.schedule(...args);
  }

  cancel(...args: Parameters<TaskCommandService['cancel']>) {
    return this.commands.cancel(...args);
  }

  list(...args: Parameters<TaskQueryService['list']>) {
    return this.queries.list(...args);
  }

  detail(...args: Parameters<TaskQueryService['detail']>) {
    return this.queries.detail(...args);
  }

  handoff(...args: Parameters<TaskEvidenceService['handoff']>) {
    return this.evidence.handoff(...args);
  }

  syncMetrics(...args: Parameters<TaskMetricsService['syncMetrics']>) {
    return this.metrics.syncMetrics(...args);
  }

  dispatchDue() {
    return this.dispatcher.dispatchDue();
  }

  pollAutomaticResults() {
    return this.receipts.pollAutomaticResults();
  }
}
```

以上只是 Facade 结构示例，不是完整替换文件。实施时必须：

1. 将当前 `TasksService` 所有公开方法逐个代理；
2. 保留原有参数类型、返回类型、异常行为和可选参数；
3. 保留 Worker 目前使用的公开方法；
4. 检查 Controller 是否依赖某些非公开辅助方法；
5. 不要为了方便而使用 `any`；
6. 若 `Parameters<...>` 导致类型导出或循环依赖问题，优先提取共享
  DTO/输入类型，而不是强行使用类型断言。

### 5.1 模块注册

`TasksModule` 逐步注册新服务：

```typescript
@Module({
  imports: [
    AccountsModule,
    ContentModule,
    NotificationsModule,
    PrismaModule,
  ],
  controllers: [TasksController],
  providers: [
    TasksService,
    TaskCommandService,
    TaskQueryService,
    TaskEvidenceService,
    TaskMetricsService,
    TaskDispatchService,
    TaskClaimService,
    TaskExecutorService,
    TaskLeaseService,
    TaskReceiptService,
  ],
  exports: [TasksService, TaskDispatchService, TaskReceiptService],
})
export class TasksModule {}
```

实际依赖应按每个服务的构造函数精简，不要为了省事让所有服务都注入所有模块。

---

## 6. 任务状态统一迁移

### 6.1 设计目标

任务状态变更应统一执行：

1. 校验当前状态是否允许迁移；
2. 更新 `PublishTask`；
3. 写入 `TaskEvent`；
4. 保证两项写入在同一数据库事务中完成。

统一入口不应把 Prisma
事务隐藏在一个会自动开启新事务的函数里。调用方应显式传入当前事务客户端，避免嵌套事务和事务边界不清楚。

### 6.2 推荐实现形式

新建 `apps/api/src/tasks/domain/task-transition.ts`。

下面是结构示例，最终类型名称应以当前生成的 Prisma Client 和
`packages/shared/src/status.ts` 为准：

```typescript
import type { Prisma, TaskStatus, TaskEventKind } from '@prisma/client';
import { assertTransition } from '@matrixark/shared';

type TransitionInput = {
  task: {
    id: string;
    workspaceId: string;
    status: TaskStatus;
  };
  to: TaskStatus;
  kind: TaskEventKind;
  actorId?: string | null;
  reason?: string;
  details?: Prisma.InputJsonValue;
};

export async function transitionTask(
  tx: Prisma.TransactionClient,
  input: TransitionInput,
) {
  const { task, to, kind, actorId, reason, details } = input;

  assertTransition(task.status, to);

  const updated = await tx.publishTask.update({
    where: { id: task.id },
    data: { status: to },
  });

  await tx.taskEvent.create({
    data: {
      workspaceId: task.workspaceId,
      taskId: task.id,
      kind,
      fromStatus: task.status,
      toStatus: to,
      actorId: actorId ?? null,
      reason: reason ?? null,
      details: details ?? {},
    },
  });

  return updated;
}
```

注意：

- 上述代码需要根据当前 Prisma Enum、`assertTransition` 的签名和
`TaskEvent.details` 的 JSON 类型进行编译适配；
- 如果当前事件类型要求额外字段，应完整保留；
- 不要通过 `as any` 绕过类型错误；
- 不要在该函数内开启另一个 `$transaction`；
- 调用方应先获取正确的任务行锁，再将最新状态传入。

### 6.3 批量暂停任务的特殊处理

内容模块在稿件归档、版本被取代时，可能需要批量暂停多个 `scheduled`
任务。

不能为了统一入口而把批量更新改成逐条查询和更新，导致性能退化。

建议增加专用事务函数：

```typescript
async function pauseScheduledTasksInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    where: Prisma.PublishTaskWhereInput;
    reason: string;
    actorId: string;
  },
) {
  // 1. 只筛选当前仍为 scheduled 的任务
  // 2. 对批量状态变化应用 scheduled -> paused 规则
  // 3. 使用批量更新
  // 4. 为每条实际变更的任务写入 TaskEvent
  // 5. 全部在调用方的同一事务中完成
}
```

需要验证 `scheduled -> paused` 是当前状态机允许的迁移。若当前
`assertTransition`
不支持，应先判断这是否是合法业务迁移，再更新共享状态规则及对应测试，不能绕过状态机。

### 6.4 迁移范围

第一阶段至少检查：

- `TasksService` 中所有直接更新 `PublishTask.status` 的代码；
- `ContentService.pauseScheduledTasks()`；
- 版本取代时暂停旧版本任务的逻辑；
- Worker 领取、执行、回执和租约恢复中的状态更新；
- 取消、核实、人工交接相关的状态变化。

可用以下命令定位：

```bash
rg -n "publishTask\\.(update|updateMany|updateManyAndReturn)" apps/api/src
rg -n "status:[[:space:]]*['\"]" apps/api/src/tasks apps/api/src/content
rg -n "assertTransition" apps/api/src packages/shared/src
```

不要机械地将所有 `updateMany`
都替换为单条状态迁移函数。批量暂停、批量归档等场景应保留适合批处理的实现，但必须共享迁移规则和事件语义。

---

## 7. 事务、锁与幂等要求

这是本轮最重要的回归区域。

### 7.1 不改变事务边界

必须保留以下模式：

```text
开启数据库事务
  ├── 校验 Workspace 和业务对象
  ├── 获取需要的行锁
  ├── 检查状态、幂等键和版本快照
  ├── 更新任务或创建领取记录
  └── 写入 TaskEvent
提交事务

事务外
  └── 调用平台 HTTP 接口

再次开启数据库事务
  ├── 校验租约仍然有效
  ├── 保存平台回执
  ├── 更新任务状态
  └── 写入 TaskEvent
提交事务
```

禁止把平台 HTTP
请求放进数据库事务。网络请求可能耗时、超时或等待平台响应，会长期占用数据库连接和行锁。

### 7.2 锁顺序

项目已有事务中使用行锁保护稿件、版本、账号和任务。重构时必须先从现有代码中确认每条业务路径的真实锁顺序，并统一记录。

此前检查到的典型顺序是：

```text
Manuscript
    ↓
Variant
    ↓
ChannelAccount
    ↓
PublishTask
```

这不是允许随意套用到所有路径的固定模板。具体事务需要按当前代码的真实依赖关系确认，不能为了符合文档而增加不必要的锁。

要求：

- 不得在持有 `PublishTask` 锁后再反向申请上游对象锁；
- 不得在一个事务中混用互相冲突的锁顺序；
- 需要改变锁顺序时，必须增加并发集成测试；
- 对死锁和序列化冲突保留可识别的错误处理。

### 7.3 幂等和租约

必须保留：

- `PublishTask.idempotencyKey` 的唯一约束；
- 当前任务领取条件；
- `leaseId` 与 `leaseExpiresAt` 校验；
- `claimedAt` 和 `attempts` 的原有语义；
- 过期租约恢复；
- 迟到回执防护；
- 同账号任务互斥规则。

不要将"网络超时"直接视为"平台未发布"。如果请求已经发出但响应丢失，平台侧可能已经成功，任务应按现有机制进入待核实或回读流程，不能盲目重复发布。

---

## 8. 平台逻辑迁移边界

第一阶段不完整实现 Adapter Registry，但必须为第二阶段留出清晰边界。

### 8.1 第一阶段先做的事

对 `TasksService` 中所有平台判断和 B 站专属依赖做盘点：

```bash
rg -n "bilibili|xiaohongshu|BilibiliAdapter|validateBilibiliArticle|publishChannel" \
  apps/api/src/tasks apps/api/src/accounts packages/adapters/src
```

将每处逻辑分类：

  逻辑                       目标归属

---

  平台内容字段合法性         PlatformContentPolicy
  账号是否具备某种发布能力   AccountCapabilityResolver
  平台凭据解密和提供         PlatformCredentialService
  平台 HTTP 请求和签名       对应 Adapter
  通用任务领取和租约         TaskClaimService / TaskLeaseService
  任务状态和事件             TaskTransition / TaskLifecycle
  发布结果持久化             TaskReceiptService

第一阶段可以暂时保留现有调用，只要通过独立函数或服务隔离依赖，并且不扩大平台专属分支。

### 8.2 第二阶段目标接口

后续可以建立：

```typescript
interface PlatformContentPolicy {
  validateVariant(
    variant: VariantSnapshot,
  ): ValidationIssue[];
}

interface PlatformAccountPolicy {
  resolveChannel(
    account: AccountSnapshot,
    now: Date,
  ): ChannelDecision;
}
```

Adapter Registry
应由运行时模块负责解析工厂，任务核心只依赖抽象能力，不直接
`new BilibiliAdapter()`。

**不要在第一阶段同时改接口、改业务逻辑和改平台实现。**

---

## 9. Worker 本轮处理范围

第一阶段只做必要兼容，不改造执行并发。

### 9.1 本轮要求

- Worker 仍然能够调用原有 `dispatchDue()`；
- Worker 仍然能够调用自动结果回读方法；
- 任务调度频率和执行行为保持不变；
- 不改变任务候选查询条件；
- 不改变租约时长；
- 不改变每轮派发数量；
- 不改变人工交接任务的处理顺序；
- 不引入新的后台队列。

### 9.2 后续阶段再做

后续独立 PR 再处理：

- WorkerModule；
- WorkerRunner；
- 发布、回执、指标、通知、选题等 Poller；
- 有界并发；
- 平台级并发限制；
- WorkerHeartbeat；
- 积压和超时监控。

这样可以将"职责拆分"和"执行策略变化"分开验证，减少故障定位难度。

---

## 10. 具体实施顺序

建议按小 PR 或小提交推进，不要一次性完成全部搬迁。

### PR 0：基线检查与方法清单

**目的：** 建立当前分支的真实基线。

操作：

1. 确认分支和工作区状态；
2. 记录当前 Commit；
3. 盘点 `TasksService` 所有方法；
4. 搜索全部调用方；
5. 搜索任务状态直接写入点；
6. 记录现有测试脚本和通过结果。

命令：

```bash
git status --short
git rev-parse HEAD

rg -n "^[[:space:]]*(async[[:space:]]+)?[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*\\(" \
  apps/api/src/tasks/tasks.service.ts

rg -n "TasksService|tasksService\\." apps/api/src

rg -n "publishTask\\.(update|updateMany|updateManyAndReturn)" apps/api/src
```

交付物：

- `tasks-service-method-inventory.md`；
- 当前测试基线记录；
- 本次重构涉及文件清单。

验收：

- 所有公开方法均有归属；
- 所有调用方均已识别；
- 当前分支可以正常执行基线检查。

### PR 1：抽取任务查询服务

**目的：** 先迁移无副作用的查询逻辑。

迁移：

- `list`；
- `detail`；
- 其他只读列表、汇总和详情方法。

要求：

- 保留原有 Workspace 条件；
- 保留角色权限过滤；
- 保留分页、排序和游标；
- 保留关联查询；
- 不改变响应结构；
- 不将查询逻辑误放进命令服务。

验收：

- API 响应结构一致；
- 查询结果和权限行为一致；
- 相关集成测试通过。

### PR 2：抽取交接与证据服务

迁移：

- 人工交接；
- 交接证据读取；
- 截图或附件关联；
- 相关交接状态和事件记录。

要求：

- 保留素材归属检查；
- 保留 Workspace 隔离；
- 保留交接时间和通知触发逻辑；
- 不把文件下载权限交给前端决定。

验收：

- 人工交接原流程通过；
- 非授权用户无法读取其他工作室证据；
- 重复提交不会产生不一致事件。

### PR 3：抽取成效服务

迁移：

- 指标记录；
- 手动同步；
- 自动同步；
- 到期同步；
- 指标历史和趋势查询（如果当前实现与查询服务边界更匹配，也可归入
QueryService）。

要求：

- 保留来源、采集时间和操作者；
- 保留重复触发去重；
- 保留真实发布结果过滤；
- 保留试用工作室数据隔离；
- 保留缺失指标与真实零值的区别。

验收：

- 手动记录和同步结果一致；
- 重复触发不会重复写入；
- 趋势数据与现有结果一致。

### PR 4：抽取任务命令服务

迁移：

- `schedule`；
- `changeSchedule`；
- `cancel`；
- `verify`；
- 结果记录和更正等用户发起的写操作。

要求：

- 保留原事务边界；
- 保留任务幂等键；
- 保留账号与版本检查；
- 保留审核快照校验；
- 保留状态迁移限制；
- 保留任务事件；
- 不在事务中调用外部平台。

验收：

- 重复排期行为不变；
- 取消、改期、核实行为不变；
- 权限和冲突错误保持一致；
- 数据库集成测试通过。

### PR 5：抽取后台派发、领取和回执

建议分成三个小提交：

1. `TaskClaimService`：领取事务、租约和幂等；
2. `TaskExecutorService`：Adapter 前置校验、执行和外部请求；
3. `TaskDispatchService` / `TaskReceiptService`：扫描编排和状态回读。

要求：

- 不改变候选任务查询；
- 不改变租约字段语义；
- 不改变平台请求参数；
- 不改变回执幂等；
- 不改变失败与待核实的区分；
- 不改变 Worker 调用入口。

验收：

- Worker 可以正常启动；
- 沙箱发布链路通过；
- 人工交接链路通过；
- B 站模拟或已有隔离测试通过；
- 过期租约恢复测试通过；
- 迟到回执测试通过。

### PR 6：统一状态迁移入口

迁移：

- `TasksService` 中直接更新任务状态的逻辑；
- `ContentService.pauseScheduledTasks()`；
- 版本取代时暂停任务的逻辑；
- 其他直接更新 `PublishTask.status` 的位置。

要求：

- 使用统一迁移规则；
- 保留批量更新能力；
- 同一事务写入任务事件；
- 不改变原事件类型、原因和操作者；
- 对不合法迁移明确报错。

验收：

- 全仓任务状态更新点完成审查；
- 状态机单元测试通过；
- 归档、版本取代、取消、领取、回执等集成测试通过。

### PR 7：整理模块依赖与 CI

完成：

- 清理不再使用的旧方法和导入；
- 检查 NestJS 模块循环依赖；
- 检查 Worker 的公开依赖；
- 修复 `infra/ci/select-targets.mjs`；
- 为新服务增加单元测试；
- 更新架构文档和待办文档。

注意：只有在确认所有调用方已经迁移后，才能删除旧实现。不要为了让旧文件变短而留下空代理、重复实现或未使用的
Provider。

---

## 11. 测试与回归方案

### 11.1 每个 PR 必须执行

先确认根目录和各 Workspace 当前 `package.json`
中的脚本名称，再执行项目实际提供的命令。至少覆盖：

```bash
pnpm typecheck
pnpm --filter @matrixark/shared test
pnpm --filter @matrixark/api build
pnpm --filter @matrixark/web build
```

以上命令是建议检查项，若当前仓库脚本名称不同，应以实际 `package.json`
为准。

### 11.2 数据库集成测试

优先覆盖：

  场景                     预期

---

  同一版本、账号重复排期   不产生重复任务
  同一账号并发领取         只有一个领取成功
  不同账号领取             互不阻塞，结果正确
  版本内容发生变化         旧任务按原规则暂停或失效
  稿件归档                 相关待发布任务按规则暂停
  任务取消                 状态和事件一致
  人工交接                 交接时间、状态和事件一致
  回执重复提交             不重复产生结果
  Worker 租约过期          按原规则恢复或进入待核实
  旧租约迟到回执           不覆盖新状态
  跨 Workspace 查询        无法读取其他工作室数据
  成效重复同步             去重规则有效
  试用数据                 不进入真实运营统计

### 11.3 Adapter 契约回归

第一阶段不要求新增平台，但必须保证现有 Adapter 行为没有变化：

- B 站 `preflight` 仍然执行；
- B 站 `publish` 参数保持一致；
- B 站状态回读保持一致；
- 人工交接通道保持一致；
- 沙箱通道保持一致；
- Adapter 错误类型仍能正确映射；
- 原始平台凭据不进入日志或普通事件详情。

### 11.4 回归记录

每个 PR 记录：

```text
PR：
Commit：
变更文件：
迁移的方法：
新增测试：
执行命令：
测试结果：
数据库结构是否变化：
API 契约是否变化：
Worker 行为是否变化：
未解决问题：
回滚方式：
```

不要只写"测试通过"。必须记录实际执行的命令和结果。

---

## 12. CI 触发条件修复

此前检查发现，`infra/ci/select-targets.mjs`
的数据库检查路径列表需要审查，特别是认证、工作室和通知等模块的改动是否触发了正确的数据库集成检查。

建议至少检查以下路径：

```javascript
const databasePaths = [
  'apps/api/prisma/',
  'apps/api/src/tasks/',
  'apps/api/src/content/',
  'apps/api/src/accounts/',
  'apps/api/src/auth/',
  'apps/api/src/workspaces/',
  'apps/api/src/notifications/',
  'apps/api/test/',
];
```

这只是路径清单示例。实际实现要保留当前脚本中对公共配置、Worker、Adapter、Shared
Schema 和数据库脚本的判断逻辑，不能用一段简化代码覆盖整个现有文件。

验收方式：

1. 修改 `tasks` 文件，确认数据库检查触发；
2. 修改 `auth` 文件，确认数据库检查触发；
3. 修改 `workspaces` 文件，确认数据库检查触发；
4. 修改 `notifications` 文件，确认数据库检查触发；
5. 修改纯 Markdown 文件，确认不会无意义触发全部构建；
6. 手动触发工作流时，保留手动选择的执行行为。

---

## 13. 风险与回滚策略

---

  风险                 可能后果                     预防方式                   回滚方式

---

  方法迁移遗漏         某些 API 或 Worker 调用失败  PR 0 建立完整方法清单      回退对应迁移 PR

  参数或返回类型变化   前端或 Controller 行为异常   Facade 保留原签名          恢复旧方法代理

  事务边界变化         状态和事件不一致             逐方法迁移，保留事务参数   回退对应事务改动

  锁顺序变化           死锁或并发冲突               锁顺序审查和并发测试       回退锁相关提交

  状态机覆盖不完整     某些业务无法正常暂停或取消   状态迁移测试               恢复原有受控更新逻辑

  Worker 依赖丢失      后台任务不执行               保留原 Worker 入口         回退模块注册改动

  Adapter 行为变化     平台发布失败                 第一阶段不重写 Adapter     回退 Adapter 相关改动

## CI 漏触发            问题未在 PR 阶段发现         为路径选择脚本增加测试     回退 CI 脚本改动

### 回滚原则

- 第一阶段不修改数据库 Schema，因此正常情况下无需数据库降级；
- 每个 PR 应尽量独立可回退；
- 不要把代码迁移、数据库迁移和业务规则变更放进同一个大提交；
- 如果出现线上任务状态异常，优先暂停相关 Worker
执行并保留数据库证据，不要直接批量重置任务状态；
- 未确认平台实际发布结果时，不要盲目重试。

---

## 14. 第一阶段完成验收标准

只有同时满足以下条件，才认为核心业务解耦完成。

### 14.1 代码结构

- [x] `TasksService` 已变成 Facade；
- [x] 命令、查询、交接、成效和派发职责已拆分；
- [x] 所有旧公开方法均有兼容代理或已完成调用方迁移；
- [x] 没有为了拆分而复制两份业务实现；
- [x] 没有新增不必要的循环依赖；
- [x] 关键服务的职责和依赖已记录。

### 14.2 业务行为

- [x] 原有 API 路由和请求响应结构不变；
- [x] 任务创建、改期、取消和核实行为不变；
- [x] 人工交接和证据行为不变；
- [x] 成效记录与同步行为不变；
- [x] B 站和沙箱通道行为不变；
- [x] 小红书人工交接行为不变；
- [x] Workspace 和角色权限不退化。

### 14.3 数据与并发

- [x] 不需要新增 Prisma Migration；
- [x] 幂等键行为不变；
- [x] 租约和过期恢复行为不变；
- [x] 任务状态变化与事件写入保持事务一致；
- [x] 平台 HTTP 请求不在数据库事务中；
- [x] 迟到回执不会覆盖新状态；
- [x] 现有锁顺序没有被破坏。

### 14.4 测试与交付

- [x] TypeScript 类型检查通过；
- [x] Shared 单元测试通过；
- [x] API 构建通过；
- [x] Web 构建通过；
- [x] PostgreSQL 集成测试通过；
- [x] Worker 启动和执行回归通过；
- [x] CI 路径触发测试通过；
- [x] 文档和回归记录更新完成。

---

## 15. 后续阶段路线

第一阶段完成后，再按以下顺序推进：

  阶段     重点              主要交付

---

  阶段一   核心业务解耦      Task Facade、应用服务、统一状态迁移


  阶段二   Adapter 插件化    AdapterRegistry、平台策略、账号能力解析


  阶段三   Worker 可靠执行   WorkerModule、有界并发、心跳和积压监控


  阶段四   存储与部署        StorageDriver、S3、完整 Compose、恢复演练


  阶段五   Agent 集成        受限查询和命令接口、权限审计、人工确认

### 关于 CreatorHub 的借鉴边界

CreatorHub 可以作为浏览器运行时、平台适配、资源池和调度设计的参考，但
MatrixArk 不应直接复制其全部架构。

建议吸收：

- 平台能力独立组织；
- 账号执行环境隔离；
- 后台任务并发限制；
- 资源生命周期管理；
- 统一的执行结果和错误处理。

暂时不引入：

- 与当前业务无关的浏览器自动化；
- 复杂的 Mixin 继承体系；
- 为了技术栈一致而替换 NestJS；
- 不必要的独立微服务；
- 未经评估的 Redis 队列。

---

## 16. 可直接交给 Codex 的执行指令

下面的指令可以作为第一阶段开发任务的主提示词。

> 你需要在 `12-test-12/MatrixArk` 仓库中执行"核心业务解耦第一阶段"重构。
>
> **本次唯一目标：** 将当前 `apps/api/src/tasks/tasks.service.ts`
> 中混合的业务职责拆分为多个职责明确的 Service，同时保留 `TasksService`
> 作为 Facade，保证现有 API、前端和 Worker 的行为不变。
>
> ### 执行前
>
> 1. 阅读项目
>   README、开发规范、技术设计、数据库设计、当前待办和回归记录。
> 2. 检查当前分支、工作区状态和 Commit。
> 3. 完整盘点 `TasksService` 的所有方法及其调用方。
> 4. 搜索所有 `PublishTask.status` 直接更新点。
> 5. 运行现有类型检查、单元测试、构建和可用的数据库集成测试，记录基线。
> 6. 不得覆盖用户未提交的修改。
>
> ### 实施顺序
>
> 1. 先抽取 TaskQueryService。
> 2. 再抽取 TaskEvidenceService。
> 3. 再抽取 TaskMetricsService。
> 4. 再抽取 TaskCommandService。
> 5. 再抽取
>   TaskClaimService、TaskExecutorService、TaskDispatchService、TaskLeaseService
>   和 TaskReceiptService。
> 6. 最后统一任务状态迁移入口，并处理 ContentService 中的批量暂停逻辑。
> 7. 最后整理 NestJS Provider、模块依赖、CI 触发条件和文档。
>
> ### 强制约束
>
> - 不修改 API 路由、请求响应契约和前端代码。
> - 不修改 Prisma Schema，不新增 Migration。
> - 不引入 Redis、BullMQ 或其他队列基础设施。
> - 不改变任务状态含义、租约时长、幂等规则和候选任务筛选。
> - 不改变 Worker 的派发并发策略。
> - 不重写 B 站 Adapter，不增加新平台。
> - 不在数据库事务中执行网络请求。
> - 不允许跨 Workspace 读取或修改数据。
> - 不允许用 `any`、空实现或删除测试来绕过类型错误。
> - 不允许仅移动文件而复制出两份业务逻辑。
> - 不允许一次性重写整个 `TasksService`；必须分批迁移并验证。
>
> ### 每次迁移必须做到
>
> 1. 保留原有参数、返回类型和错误语义。
> 2. 保留原事务边界。
> 3. 保留原锁顺序。
> 4. 保留任务与 TaskEvent 的事务一致性。
> 5. 保留幂等、租约和迟到回执防护。
> 6. 为迁移后的服务补充对应测试。
> 7. 更新方法迁移清单和回归记录。
>
> ### 最终交付
>
> - 新目录和服务实现；
> - 保留兼容性的 `TasksService` Facade；
> - 统一任务状态迁移入口；
> - 更新后的 `TasksModule`；
> - 必要的单元测试和 PostgreSQL 集成测试；
> - 修复后的 CI 触发条件；
> - 更新后的架构文档；
> - 一份包含变更文件、迁移方法、测试命令、测试结果和遗留风险的实施报告。
>
> **完成标准：**
> 现有业务行为不变，所有相关测试通过，且可以明确证明任务状态、事务、锁、幂等和租约语义没有退化。若发现现有代码与计划不一致，先记录差异并提出最小调整，不得擅自扩大重构范围。

---

## 17. 最终实施建议

MatrixArk 当前最重要的是稳定业务内核，而不是继续增加平台数量。

第一阶段完成后，应该能够清楚回答：

- 一条发布任务是由哪个服务创建的？
- 哪个服务负责改变任务状态？
- 哪个服务负责领取任务？
- 哪个服务真正调用平台？
- 哪个服务处理平台回执？
- 哪个服务负责指标同步？
- Worker 为什么能够安全恢复？
- 新增平台时，哪些旧代码不需要修改？

如果这些问题都能在代码结构中得到明确答案，那么第一阶段才算真正完成。

**最终原则：先拆职责，再拆平台；先稳定事务，再提高并发；先保证可恢复，再追求自动化。**
