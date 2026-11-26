import { randomUUID } from 'node:crypto';
import { BadGatewayException, ConflictException, ForbiddenException } from '@nestjs/common';
import { BilibiliAdapter } from '@matrixark/adapters';
import { Prisma } from '@prisma/client';
import { can } from '../common/permissions';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { workspacePlatformApp } from './platform-app';
import { encryptBilibiliCredentials } from './publish-account';

export async function bindBilibiliAccount(prisma: PrismaService, workspaceId: string, operatorId: string,
  { accessToken, expiresAt }: { accessToken: string; expiresAt: Date },
  app?: { appId: string; appSecret: string; revision: string }) {
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) throw new ConflictException('B 站账号授权已到期。');
  const membershipKey = { userId: operatorId, workspaceId };
  const member = await prisma.membership.findUnique({ where: { userId_workspaceId: membershipKey } });
  if (!member || !can(member.role, 'account:manage')) throw new ForbiddenException('无权管理该工作室账号。');
  const adapter = new BilibiliAdapter(app ? { clientId: app.appId, clientSecret: app.appSecret } : config.bilibili);
  const { openid, name, scopes } = await adapter.authorizedAccount(accessToken).catch(() => {
    throw new BadGatewayException('B 站账号核验失败。请检查应用凭据、访问令牌、专栏投稿及数据回读权限。');
  });

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
    const current = await tx.membership.findUnique({ where: { userId_workspaceId: membershipKey } });
    if (!current || !can(current.role, 'account:manage')) throw new ForbiddenException('无权管理该工作室账号。');
    if (app) {
      const setting = await workspacePlatformApp(tx, workspaceId, 'bilibili');
      if (setting?.secretCiphertext !== app.revision) throw new ConflictException('B 站应用凭据已更新，请重新连接账号。');
    }
    const scope = { workspaceId, platform: 'bilibili' as const, archivedAt: null };
    const existing = await tx.channelAccount.findFirst({ where: { ...scope, externalId: openid } });
    if (existing && existing.channelKind !== 'official') throw new ConflictException('此身份已绑定到其他发布通道。');
    const now = new Date();
    if (expiresAt <= now) throw new ConflictException('B 站账号授权已到期。');
    const id = existing?.id ?? randomUUID();
    const authorization = {
      ...encryptBilibiliCredentials({ id, workspaceId, externalId: openid }, accessToken, Boolean(app)),
      credentials: Prisma.DbNull, credentialsUpdatedAt: now, authStatus: 'active' as const,
      accessMethod: 'oauth' as const,
      authExpiresAt: expiresAt, authScope: scopes, authCheckedAt: now, authAuthorizedBy: operatorId,
    };
    if (existing) {
      await tx.channelAccount.update({ where: { id }, data: authorization });
    } else {
      // 唯一索引包含已归档账号，取名时必须一并避开，否则同名昵称会撞唯一键报 500。
      const names = new Set((await tx.channelAccount.findMany({
        where: { workspaceId, platform: 'bilibili' }, select: { displayName: true },
      })).map(({ displayName }) => displayName));
      const nickname = [...name].slice(0, 50).join('');
      let displayName = nickname;
      for (let suffix = 2; names.has(displayName); suffix++) displayName = `${nickname} (${suffix})`;
      await tx.channelAccount.create({
        data: { ...scope, ...authorization, id, displayName, externalId: openid, channelKind: 'official' },
      });
    }
    return id;
  });
}
