import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { AccountsController } from './accounts.controller';
import { AccountsRuntimeModule } from './accounts-runtime.module';
import { BilibiliOAuthController } from './bilibili-oauth';

@Module({
  imports: [NotificationsModule, AccountsRuntimeModule],
  controllers: [AccountsController, BilibiliOAuthController],
  exports: [AccountsRuntimeModule],
})
export class AccountsModule {}
