import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsRuntimeModule } from './notifications-runtime.module';

@Module({
  imports: [NotificationsRuntimeModule],
  controllers: [NotificationsController],
  exports: [NotificationsRuntimeModule],
})
export class NotificationsModule {}
