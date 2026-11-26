import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from './auth/decorators';
import { PrismaService } from './prisma/prisma.service';
import { WorkerMonitorService } from './worker/worker-monitor.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly monitor: WorkerMonitorService,
  ) {}

  @Public()
  @Get()
  async readiness() {
    try {
      await this.prisma.workspace.findFirst({ select: { id: true } });
      return { ok: true };
    } catch {
      throw new ServiceUnavailableException('数据库暂不可用');
    }
  }

  @Public()
  @Get('worker')
  async workerHealth() {
    try {
      return await this.monitor.getSnapshot();
    } catch {
      throw new ServiceUnavailableException('Worker 监控数据暂不可用');
    }
  }
}
