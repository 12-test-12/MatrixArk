import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { ContentModule } from '../content/content.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [AccountsModule, ContentModule, NotificationsModule, PrismaModule],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
