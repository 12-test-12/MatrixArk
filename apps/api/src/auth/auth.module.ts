import { Module } from '@nestjs/common';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AuthController } from './auth.controller';
import { SessionService } from './session.service';

@Module({
  imports: [WorkspacesModule],
  controllers: [AuthController],
  providers: [SessionService],
  exports: [SessionService],
})
export class AuthModule {}
