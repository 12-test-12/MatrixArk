import { Module } from '@nestjs/common';
import { NotificationsRuntimeModule } from '../notifications/notifications-runtime.module';
import { AccountOnboardingService } from './account-onboarding.service';
import { AccountRiskService } from './account-risk.service';
import { BilibiliOAuthService } from './bilibili-oauth';
import { MatrixGroupsService } from './matrix-groups.service';
import { XiaohongshuIdentityService } from './xiaohongshu-identity.service';
import { LocalBrowserProfiles } from './local-browser-profiles';
import { config } from '../config';

@Module({
  imports: [NotificationsRuntimeModule],
  providers: [
    { provide: LocalBrowserProfiles, useFactory: () => new LocalBrowserProfiles(config.localBrowser) },
    XiaohongshuIdentityService,
    BilibiliOAuthService,
    MatrixGroupsService,
    AccountRiskService,
    AccountOnboardingService,
  ],
  exports: [
    LocalBrowserProfiles,
    XiaohongshuIdentityService,
    BilibiliOAuthService,
    MatrixGroupsService,
    AccountRiskService,
    AccountOnboardingService,
  ],
})
export class AccountsRuntimeModule {}
