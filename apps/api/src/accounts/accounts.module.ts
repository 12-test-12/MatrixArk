import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { AccountsController } from './accounts.controller';
import { AccountOnboardingService } from './account-onboarding.service';
import { AccountRiskService } from './account-risk.service';
import { BilibiliOAuthController, BilibiliOAuthService } from './bilibili-oauth';
import { MatrixGroupsService } from './matrix-groups.service';
import { XiaohongshuIdentityService } from './xiaohongshu-identity.service';

@Module({
  imports: [NotificationsModule],
  controllers: [AccountsController, BilibiliOAuthController],
  providers: [
    XiaohongshuIdentityService,
    BilibiliOAuthService,
    MatrixGroupsService,
    AccountRiskService,
    AccountOnboardingService,
  ],
  exports: [AccountRiskService, MatrixGroupsService],
})
export class AccountsModule {}
