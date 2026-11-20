import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthedRequest } from '../auth/decorators';

/**
 * 工作室是权限和数据的边界：所有带 :workspaceId 的路由都必须过这道关。
 * 找不到成员关系一律 403（不返回 404，避免探测别人的工作室 id 是否存在）。
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const workspaceId = request.params?.workspaceId;
    const user = request.user;

    if (typeof workspaceId !== 'string' || !workspaceId) throw new ForbiddenException('缺少工作室标识');
    if (!user) throw new ForbiddenException('未登录');

    const membership = await this.prisma.membership.findUnique({
      where: { userId_workspaceId: { userId: user.id, workspaceId } },
    });
    if (!membership) throw new ForbiddenException('你不是该工作室的成员');

    request.membership = membership;
    return true;
  }
}
