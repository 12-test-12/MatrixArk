import {
  Body,
  Controller,
  ConflictException,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { Prisma, type Role } from '@prisma/client';
import { CurrentMembership, CurrentUser } from '../auth/decorators';
import type { SessionUser } from '../auth/session.service';
import { assertCan } from '../common/permissions';
import { parse } from '../common/zod';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceGuard } from '../workspaces/workspace.guard';
import { bindBilibiliAccount } from './bilibili-account';
import { encryptPlatformSecret, readPlatformApp, workspacePlatformApp } from './platform-app';
import { publishChannel } from './publish-account';
import { XiaohongshuIdentityService } from './xiaohongshu-identity.service';

const updateAccountSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  operator: z.string().trim().max(40).optional(),
}).strict();
const platformSchema = z.enum(['xiaohongshu', 'bilibili']);
const appSchema = z.object({
  appId: z.string().trim().regex(/^[!-~]{1,256}$/, '请填写开放平台应用 ID'),
  appSecret: z.string().trim().regex(/^[!-~]{1,512}$/, '请填写开放平台应用密钥'),
}).strict();
const bilibiliGrantSchema = z.object({
  accessToken: z.string().trim().regex(/^[!-~]{1,4096}$/, '请填写开放平台账号访问令牌'),
  expiresAt: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
}).strict();

@Controller('workspaces/:workspaceId/accounts')
@UseGuards(WorkspaceGuard)
export class AccountsController {
  constructor(private readonly prisma: PrismaService, private readonly xiaohongshu: XiaohongshuIdentityService) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string, @Query('archived') archived?: string) {
    const accounts = await this.prisma.channelAccount.findMany({
      where: { workspaceId, archivedAt: archived === 'true' ? { not: null } : null },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { tasks: true } } },
    });
    const now = new Date();
    return accounts.map((account) => {
      const channel = publishChannel(account, now);
      return {
        id: account.id,
        platform: account.platform,
        channelKind: account.channelKind,
        displayName: account.displayName,
        operator: account.operator,
        identityVerified: Boolean(account.externalId && account.authCheckedAt),
        identityCheckedAt: account.authCheckedAt,
        availableForHandoff: channel === 'manual',
        availableForOfficial: channel === 'official' || channel === 'sandbox',
        hasCredentials: Boolean(account.credentialsCiphertext || account.credentials),
        taskCount: account._count.tasks,
        createdAt: account.createdAt,
        archivedAt: account.archivedAt,
      };
    });
  }

  @Post()
  create(@CurrentMembership() membership: { role: Role }) {
    assertCan(membership.role, 'account:manage');
    throw new ConflictException('通过平台授权核验身份后才能添加发布账号。');
  }

  @Get('platform-settings')
  async platformSettings(@Param('workspaceId') workspaceId: string, @CurrentMembership() membership: { role: Role }) {
    assertCan(membership.role, 'account:manage');
    const settings = await this.prisma.platformAppSetting.findMany({ where: { workspaceId }, select: { platform: true } });
    return {
      xiaohongshu: settings.some(({ platform }) => platform === 'xiaohongshu')
        || Boolean(config.xiaohongshu.appId && config.xiaohongshu.appSecret),
      bilibili: settings.some(({ platform }) => platform === 'bilibili') || config.bilibili.enabled,
      bilibiliSandbox: config.sandboxChannel,
    };
  }

  @Patch('platform-settings/:platform')
  async savePlatformSettings(
    @Param('workspaceId') workspaceId: string,
    @Param('platform') platformParam: string,
    @CurrentMembership() membership: { role: Role },
    @CurrentUser() user: SessionUser,
    @Body() body: unknown,
  ) {
    assertCan(membership.role, 'workspace:settings');
    const platform = parse(platformSchema, platformParam);
    const { appId, appSecret } = parse(appSchema, body);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
      const existing = await workspacePlatformApp(tx, workspaceId, platform);
      const currentAppId = existing?.appId ?? (platform === 'xiaohongshu' ? config.xiaohongshu.appId : config.bilibili.clientId);
      if (currentAppId && currentAppId !== appId && await tx.channelAccount.findFirst({
        where: { workspaceId, platform, externalId: { not: null }, authCheckedAt: { not: null }, channelKind: { not: 'sandbox' } },
        select: { id: true },
      })) {
        throw new ConflictException('已有账号绑定到原应用，请填写原应用 ID。可以更新该应用的密钥。');
      }
      const data = { appId, secretCiphertext: encryptPlatformSecret(['app', workspaceId, platform, appId], appSecret), updatedById: user.id };
      await tx.platformAppSetting.upsert({
        where: { workspaceId_platform: { workspaceId, platform } },
        create: { workspaceId, platform, ...data }, update: data, select: { platform: true },
      });
    });
    return { configured: true };
  }

  @Post('bilibili/bind')
  async bindBilibili(@Param('workspaceId') workspaceId: string, @CurrentMembership() membership: { role: Role },
    @CurrentUser() user: SessionUser, @Body() body: unknown) {
    assertCan(membership.role, 'account:manage');
    if (config.sandboxChannel) throw new ConflictException('当前使用沙箱，请联系部署管理员关闭沙箱后连接真实 B 站账号。');
    const grant = parse(bilibiliGrantSchema, body);
    const app = await readPlatformApp(this.prisma, workspaceId, 'bilibili');
    if (!app && !config.bilibili.enabled) throw new ConflictException('请先在发布账号页保存 B 站开放平台应用凭据。');
    const id = await bindBilibiliAccount(this.prisma, workspaceId, user.id, grant, app);
    return { id };
  }

  @Post('xiaohongshu/authorize')
  authorizeXiaohongshu(
    @CurrentMembership() membership: { role: Role },
    @CurrentUser() user: SessionUser,
    @Param('workspaceId') workspaceId: string,
  ) {
    assertCan(membership.role, 'account:manage');
    return this.xiaohongshu.start(workspaceId, user.id);
  }

  @Post('xiaohongshu/authorize/:id/poll')
  @HttpCode(200)
  pollXiaohongshu(
    @CurrentMembership() membership: { role: Role },
    @CurrentUser() user: SessionUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    assertCan(membership.role, 'account:manage');
    return this.xiaohongshu.poll(workspaceId, user.id, id);
  }

  @Patch(':id')
  async update(
    @CurrentMembership() membership: { role: Role },
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    assertCan(membership.role, 'account:manage');
    const input = parse(updateAccountSchema, body);
    const existing = await this.prisma.channelAccount.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('账号不存在');
    if (existing.externalId && existing.authCheckedAt && input.displayName !== undefined) {
      throw new ConflictException('已核验账号使用平台昵称。');
    }
    return this.prisma.channelAccount.update({
      where: { id }, data: input, select: { id: true, platform: true, channelKind: true, displayName: true, operator: true },
    });
  }

  @Delete(':id')
  async remove(
    @CurrentMembership() membership: { role: Role },
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: SessionUser,
  ) {
    assertCan(membership.role, 'account:manage');
    return this.prisma.$transaction(async (tx) => {
      const [account] = await tx.$queryRaw<{ archivedAt: Date | null }[]>`
        SELECT "archivedAt" FROM "ChannelAccount" WHERE id = ${id} AND "workspaceId" = ${workspaceId} FOR UPDATE
      `;
      if (!account) throw new NotFoundException('账号不存在');
      if (account.archivedAt) return { ok: true };
      const active = await tx.publishTask.findFirst({
        where: { workspaceId, accountId: id, status: { in: ['scheduled', 'dispatching', 'handed_off', 'submitted', 'under_review'] } },
        select: { id: true },
      });
      if (active) throw new ConflictException('该账号还有未完成的发布任务，请处理后再归档');
      await tx.channelAccount.update({ where: { id }, data: { archivedAt: new Date(), archivedById: user.id } });
      return { ok: true };
    });
  }

  @Patch(':id/restore')
  async restore(@CurrentMembership() membership: { role: Role },
    @Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    assertCan(membership.role, 'account:manage');
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
        const [account] = await tx.$queryRaw<{ archivedAt: Date | null }[]>`
          SELECT "archivedAt" FROM "ChannelAccount" WHERE id = ${id} AND "workspaceId" = ${workspaceId} FOR UPDATE
        `;
        if (!account) throw new NotFoundException('账号不存在');
        if (account.archivedAt) {
          await tx.channelAccount.update({ where: { id }, data: { archivedAt: null, archivedById: null } });
        }
        return { ok: true };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('已有启用的同名账号或同一平台身份，请先处理冲突账号');
      }
      throw error;
    }
  }
}
