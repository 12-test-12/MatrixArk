import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { AccountsController } from './accounts.controller';
import { AccountsRuntimeModule } from './accounts-runtime.module';
import { BilibiliOAuthController } from './bilibili-oauth';
import { BilibiliBrowserController } from './bilibili-browser.controller';
import { BilibiliBrowserService } from './bilibili-browser.service';

@Module({
  imports: [NotificationsModule, AccountsRuntimeModule],
  controllers: [AccountsController, BilibiliOAuthController, BilibiliBrowserController],
  providers: [BilibiliBrowserService],
  exports: [AccountsRuntimeModule, BilibiliBrowserService],
})
export class AccountsModule {}
