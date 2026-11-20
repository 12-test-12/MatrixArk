import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from './auth/decorators';
import { PrismaService } from './prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

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
}
