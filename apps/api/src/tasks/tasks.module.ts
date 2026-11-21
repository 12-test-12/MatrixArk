import { Module } from '@nestjs/common';
import { ContentModule } from '../content/content.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [ContentModule, NotificationsModule, PrismaModule],
  controllers: [TasksController],
  providers: [TasksService],
})
export class TasksModule {}
