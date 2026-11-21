import { Module } from '@nestjs/common';
import { AccountsController } from './accounts.controller';
import { XiaohongshuIdentityService } from './xiaohongshu-identity.service';

@Module({ controllers: [AccountsController], providers: [XiaohongshuIdentityService] })
export class AccountsModule {}
