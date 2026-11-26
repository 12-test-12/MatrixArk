import { Module } from '@nestjs/common';
import { ContentModule } from '../content/content.module';
import { TasksModule } from '../tasks/tasks.module';
import { TrialWorkspaceService } from './trial-workspace.service';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
  imports: [ContentModule, TasksModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService, TrialWorkspaceService],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
