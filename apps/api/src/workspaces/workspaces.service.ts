import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  /** 注册时自动开一个工作室，让新用户不用先"创建工作室"才能用 */
  async createForUser(userId: string, name: string) {
    return this.prisma.workspace.create({
      data: {
        name,
        memberships: { create: { userId, role: 'owner' } },
      },
    });
  }
}
