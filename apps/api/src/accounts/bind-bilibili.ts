import { HttpException } from '@nestjs/common';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { bindBilibiliAccount } from './bilibili-account';

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
    const id = await bindBilibiliAccount(prisma, workspaceId, operatorId, { accessToken: token, expiresAt: authExpiresAt });
    console.log(id);
  } finally {
    await prisma.$disconnect();
  }
}

bind().catch((error: unknown) => {
  // Prisma may include invocation data in its errors. Print only the deliberate, non-secret diagnostics.
  const expected = error instanceof HttpException
    || (error instanceof Error && error.constructor === Error && /^[\p{Script=Han}B]/u.test(error.message));
  console.error(expected && error instanceof Error
    ? error.message : '绑定失败，请检查开放平台授权、数据库及应用配置');
  process.exitCode = 1;
});
