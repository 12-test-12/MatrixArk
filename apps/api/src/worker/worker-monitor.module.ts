import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WorkerMonitorService } from './worker-monitor.service';

@Module({
  imports: [PrismaModule],
  providers: [WorkerMonitorService],
  exports: [WorkerMonitorService],
})
export class WorkerMonitorModule {}
