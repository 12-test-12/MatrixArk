import { randomUUID } from 'node:crypto';
import { BilibiliAdapter } from '@matrixark/adapters';
import { Prisma } from '@prisma/client';
import { config } from '../config';
import { can } from '../common/permissions';
import { PrismaService } from '../prisma/prisma.service';
import { encryptBilibiliCredentials } from './publish-account';

async function bind() {
  const [workspaceId, operatorId, expiresAtInput] = process.argv.slice(2);
  const authExpiresAt = new Date(expiresAtInput ?? '');
  if (!workspaceId || !operatorId || !Number.isFinite(authExpiresAt.getTime()) || authExpiresAt <= new Date()) {
    throw new Error('请提供工作室 ID、操作者用户 ID 和尚未过期的 ISO 8601 授权截止时间');
  }
  if (!config.bilibili.enabled) throw new Error('B 站官方通道尚未启用');
  let token = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    token += chunk;
    if (token.length > 4100) throw new Error('授权令牌格式无效');
  }
  token = token.trim();
  if (!/^[!-~]{1,4096}$/.test(token)) throw new Error('请从标准输入提供开放平台访问令牌');

  const prisma = new PrismaService();
  try {
    const membershipKey = { userId: operatorId, workspaceId };
    const member = await prisma.membership.findUnique({ where: { userId_workspaceId: membershipKey } });
    if (!member || !can(member.role, 'account:manage')) throw new Error('操作者无权管理该工作室账号');
    const { openid, name, scopes } = await new BilibiliAdapter(config.bilibili).authorizedAccount(token);
    const id = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
      const current = await tx.membership.findUnique({ where: { userId_workspaceId: membershipKey } });
      if (!current || !can(current.role, 'account:manage')) throw new Error('操作者无权管理该工作室账号');
      const scope = { workspaceId, platform: 'bilibili' as const, archivedAt: null };
      const existing = await tx.channelAccount.findFirst({ where: { ...scope, externalId: openid } });
      if (existing && existing.channelKind !== 'official') throw new Error('此身份已绑定到其他发布通道');
      const now = new Date();
      if (authExpiresAt <= now) throw new Error('授权已到期');
      const id = existing?.id ?? randomUUID();
      const authorization = {
        ...encryptBilibiliCredentials({ id, workspaceId, externalId: openid }, token),
        credentials: Prisma.DbNull, credentialsUpdatedAt: now, authStatus: 'active' as const,
        authExpiresAt, authScope: scopes, authCheckedAt: now, authAuthorizedBy: operatorId,
      };
      if (existing) {
        await tx.channelAccount.update({ where: { id }, data: authorization });
      } else {
        const names = new Set((await tx.channelAccount.findMany({ where: scope, select: { displayName: true } }))
          .map(({ displayName }) => displayName));
        const nickname = [...name].slice(0, 50).join('');
        let displayName = nickname;
        for (let suffix = 2; names.has(displayName); suffix++) displayName = `${nickname} (${suffix})`;
        await tx.channelAccount.create({
          data: { ...scope, ...authorization, id, displayName, externalId: openid, channelKind: 'official' },
        });
      }
      return id;
    });
    console.log(id);
  } finally {
    await prisma.$disconnect();
  }
}

bind().catch((error: unknown) => {
  // Prisma may include invocation data in its errors. Print only the deliberate, non-secret diagnostics.
  console.error(error instanceof Error && error.constructor === Error && /^[\p{Script=Han}B]/u.test(error.message)
    ? error.message : '绑定失败，请检查开放平台授权、数据库及应用配置');
  process.exitCode = 1;
});
