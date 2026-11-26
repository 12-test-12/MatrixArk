import { Module } from '@nestjs/common';
import { AdapterRegistry, createDefaultAdapterRegistry } from '@matrixark/adapters';
import { AccountsRuntimeModule } from '../accounts/accounts-runtime.module';
import { ContentRuntimeModule } from '../content/content-runtime.module';
import { NotificationsRuntimeModule } from '../notifications/notifications-runtime.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TaskMetricsService } from './application/task-metrics.service';
import { TaskClaimService } from './dispatch/task-claim.service';
import { TaskDispatchService } from './dispatch/task-dispatch.service';
import { TaskExecutorService } from './dispatch/task-executor.service';
import { TaskLeaseService } from './dispatch/task-lease.service';
import { TaskReceiptService } from './dispatch/task-receipt.service';
import { BilibiliPublishingPlatform } from './infrastructure/bilibili-publishing-platform';
import { PUBLISHING_PLATFORMS } from './infrastructure/publishing-platform';
import { TaskPlatformService } from './infrastructure/task-platform.service';

@Module({
  imports: [PrismaModule, AccountsRuntimeModule, ContentRuntimeModule, NotificationsRuntimeModule],
  providers: [
    { provide: AdapterRegistry, useFactory: createDefaultAdapterRegistry },
    BilibiliPublishingPlatform,
    {
      provide: PUBLISHING_PLATFORMS,
      useFactory: (bilibili: BilibiliPublishingPlatform) => [bilibili],
      inject: [BilibiliPublishingPlatform],
    },
    TaskPlatformService,
    TaskDispatchService,
    TaskLeaseService,
    TaskExecutorService,
    TaskClaimService,
    TaskReceiptService,
    TaskMetricsService,
  ],
  exports: [
    AdapterRegistry,
    TaskPlatformService,
    TaskDispatchService,
    TaskLeaseService,
    TaskExecutorService,
    TaskClaimService,
    TaskReceiptService,
    TaskMetricsService,
  ],
})
export class TasksRuntimeModule {}
