import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { ContentModule } from '../content/content.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TaskCommandService } from './application/task-command.service';
import { TaskEvidenceService } from './application/task-evidence.service';
import { TaskQueryService } from './application/task-query.service';
import { TasksController } from './tasks.controller';
import { TasksRuntimeModule } from './tasks-runtime.module';
import { TasksService } from './tasks.service';

@Module({
  imports: [PrismaModule, AccountsModule, ContentModule, NotificationsModule, TasksRuntimeModule],
  controllers: [TasksController],
  providers: [
    TaskCommandService,
    TaskEvidenceService,
    TaskQueryService,
    TasksService,
  ],
  exports: [TasksService, TasksRuntimeModule],
})
export class TasksModule {}
