import { Module } from '@nestjs/common';
import { NotificationsRuntimeModule } from '../notifications/notifications-runtime.module';
import { AccountOnboardingService } from './account-onboarding.service';
import { AccountRiskService } from './account-risk.service';
import { BilibiliOAuthService } from './bilibili-oauth';
import { MatrixGroupsService } from './matrix-groups.service';
import { XiaohongshuIdentityService } from './xiaohongshu-identity.service';

@Module({
  imports: [NotificationsRuntimeModule],
  providers: [
    XiaohongshuIdentityService,
    BilibiliOAuthService,
    MatrixGroupsService,
    AccountRiskService,
    AccountOnboardingService,
  ],
  exports: [
    XiaohongshuIdentityService,
    BilibiliOAuthService,
    MatrixGroupsService,
    AccountRiskService,
    AccountOnboardingService,
  ],
})
export class AccountsRuntimeModule {}
