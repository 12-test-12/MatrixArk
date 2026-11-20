import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Role } from '@prisma/client';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';

export const SESSION_COOKIE = 'ma_session';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  /** 返回原始 token（只给浏览器），库里只存哈希 */
  async create(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1000);
    await this.prisma.session.create({ data: { id: sha256(token), userId, expiresAt } });
    return { token, expiresAt };
  }

  async resolve(token: string): Promise<SessionUser | null> {
    const session = await this.prisma.session.findUnique({
      where: { id: sha256(token) },
      include: { user: true },
    });
    if (!session) return null;
    if (session.expiresAt.getTime() <= Date.now()) {
      await this.prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
      return null;
    }
    return { id: session.user.id, email: session.user.email, name: session.user.name };
  }

  async destroy(token: string): Promise<void> {
    await this.prisma.session.delete({ where: { id: sha256(token) } }).catch(() => undefined);
  }

  async workspacesOf(userId: string): Promise<Array<{ id: string; name: string; role: Role }>> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((m) => ({ id: m.workspace.id, name: m.workspace.name, role: m.role }));
  }
}
