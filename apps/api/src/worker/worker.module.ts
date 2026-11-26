import { Module } from '@nestjs/common';
import { AccountsRuntimeModule } from '../accounts/accounts-runtime.module';
import { ContentRuntimeModule } from '../content/content-runtime.module';
import { NotificationsRuntimeModule } from '../notifications/notifications-runtime.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TasksRuntimeModule } from '../tasks/tasks-runtime.module';
import { WorkerHeartbeatService } from './worker-heartbeat.service';
import { WorkerMonitorModule } from './worker-monitor.module';
import { WorkerRunnerService } from './worker-runner.service';

@Module({
  imports: [
    PrismaModule,
    WorkerMonitorModule,
    NotificationsRuntimeModule,
    AccountsRuntimeModule,
    ContentRuntimeModule,
    TasksRuntimeModule,
  ],
  providers: [WorkerHeartbeatService, WorkerRunnerService],
  exports: [WorkerHeartbeatService, WorkerRunnerService, WorkerMonitorModule],
})
export class WorkerModule {}
