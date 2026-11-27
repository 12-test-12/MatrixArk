import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  ConflictException,
  Delete,
  Get,
  Header,
  Headers,
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
import { CurrentMembership, CurrentTrial, CurrentUser } from '../auth/decorators';
import type { SessionUser } from '../auth/session.service';
import { assertCan } from '../common/permissions';
import { parse } from '../common/zod';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceGuard } from '../workspaces/workspace.guard';
import {
  AccountOnboardingService,
  cookieImportSchema,
  passwordAccountSchema,
  readSessionSchema,
} from './account-onboarding.service';
import { AccountRiskService } from './account-risk.service';
import { cleanTags, normalizeEgressIp } from './account-secrets';
import { bindBilibiliAccount } from './bilibili-account';
import { BilibiliOAuthService, configuredBilibiliOAuthOrigin } from './bilibili-oauth';
import {
  batchAccountsSchema,
  createMatrixGroupSchema,
  MatrixGroupsService,
  updateMatrixGroupSchema,
} from './matrix-groups.service';
import { encryptPlatformSecret, readPlatformApp, workspacePlatformApp } from './platform-app';
import { parseProfileInput, resolveAccountProfileUrl } from './publish-account';
import { derivePlatformUid, resolveAccountCapabilities } from './account-capabilities';
import { XiaohongshuIdentityService } from './xiaohongshu-identity.service';

const updateAccountSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  operator: z.string().trim().max(40).optional(),
  groupId: z.string().min(1).nullable().optional(),
  alias: z.string().trim().max(60).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(24)).max(12).optional(),
  pinned: z.boolean().optional(),
  egressIp: z.string().trim().max(64).nullable().optional(),
  profileLabel: z.string().trim().max(64).nullable().optional(),
  profileUrl: z.string().trim().max(1000).nullable().optional(),
  cookieExpiresAt: z.string().datetime({ offset: true }).transform((v) => new Date(v)).nullable().optional(),
}).strict();
const platformSchema = z.enum(['xiaohongshu', 'bilibili']);
const demoAccountSchema = z.object({ platform: platformSchema, groupId: z.string().min(1).nullable().optional() }).strict();
const appSchema = z.object({
  appId: z.string().trim().regex(/^[!-~]{1,256}$/, '请填写开放平台应用 ID'),
  appSecret: z.string().trim().regex(/^[!-~]{1,512}$/, '请填写开放平台应用密钥'),
}).strict();
const bilibiliGrantSchema = z.object({
  accessToken: z.string().trim().regex(/^[!-~]{1,4096}$/, '请填写开放平台账号访问令牌'),
  expiresAt: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
}).strict();
const biliQrStartSchema = z.object({
  groupId: z.string().min(1).nullable().optional(),
}).strict().optional();
const xhsQrStartSchema = z.object({
  groupId: z.string().min(1).nullable().optional(),
}).strict().optional();
const reportRiskSchema = z.object({
  level: z.enum(['warning', 'risk']).default('risk'),
  kind: z.string().trim().min(1).max(60).default('manual_flagged'),
  message: z.string().trim().min(1, '请填写风险说明').max(300),
  forceNotify: z.boolean().optional(),
}).strict();
const resolveRiskSchema = z.object({
  note: z.string().trim().max(300).optional(),
  notify: z.boolean().optional(),
}).strict().optional();

@Controller('workspaces/:workspaceId/accounts')
@UseGuards(WorkspaceGuard)
export class AccountsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly xiaohongshu: XiaohongshuIdentityService,
    private readonly bilibiliOAuth: BilibiliOAuthService,
    private readonly groups: MatrixGroupsService,
    private readonly risks: AccountRiskService,
    private readonly onboarding: AccountOnboardingService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Param('workspaceId') workspaceId: string, @CurrentTrial() trial: boolean, @Query('archived') archived?: string) {
    const accounts = await this.prisma.channelAccount.findMany({
      where: { workspaceId, archivedAt: archived === 'true' ? { not: null } : null },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'asc' }],
      include: {
        _count: { select: { tasks: true } },
        group: { select: { id: true, name: true, color: true } },
        readAccount: { select: { id: true, displayName: true, alias: true } },
      },
    });
    const ipCounts = new Map<string, number>();
    if (archived !== 'true') {
      for (const account of accounts) {
        if (!account.egressIp) continue;
        const key = `${account.platform}:${account.egressIp}`;
        ipCounts.set(key, (ipCounts.get(key) ?? 0) + 1);
      }
    }
    const now = new Date();
    return accounts.map((account) => {
      const capabilities = resolveAccountCapabilities(account, now, trial);
      const ipKey = account.egressIp ? `${account.platform}:${account.egressIp}` : null;
      return {
        id: account.id,
        platform: account.platform,
        channelKind: account.channelKind,
        accessMethod: account.accessMethod,
        displayName: account.displayName,
        alias: account.alias,
        operator: account.operator,
        tags: account.tags,
        pinned: account.pinned,
        groupId: account.groupId,
        group: account.group,
        readAccountId: account.readAccountId,
        readAccount: account.readAccount,
        hasReadCookie: Boolean(account.readCookieCiphertext),
        readCookieLabel: account.readCookieLabel,
        readCookieUpdatedAt: account.readCookieUpdatedAt,
        readWriteSeparated: Boolean(account.readAccountId || account.readCookieCiphertext),
        egressIp: account.egressIp,
        egressIpCollision: Boolean(ipKey && (ipCounts.get(ipKey) ?? 0) > 1),
        profileLabel: account.profileLabel,
        cookieExpiresAt: account.cookieExpiresAt,
        envCheckedAt: account.envCheckedAt,
        profileUrl: resolveAccountProfileUrl(account),
        platformUid: derivePlatformUid(account),
        loginIdentifier: account.loginIdentifier,
        hasPassword: Boolean(account.passwordCiphertext),
        hasCookie: Boolean(account.cookieCiphertext),
        cookieUpdatedAt: account.cookieUpdatedAt,
        riskStatus: account.riskStatus,
        riskReason: account.riskReason,
        riskDetectedAt: account.riskDetectedAt,
        authStatus: account.authStatus,
        authExpiresAt: account.authExpiresAt,
        authCheckedAt: account.authCheckedAt,
        identityVerified: capabilities.identityVerified,
        identityCheckedAt: capabilities.identityCheckedAt,
        availableForHandoff: capabilities.availableForHandoff,
        availableForOfficial: capabilities.availableForOfficial,
        availableForMetrics: capabilities.availableForMetrics,
        capabilityReason: capabilities.capabilityReason,
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
    throw new ConflictException('请选择扫码、账号密码或 Cookie 方式添加发布账号。');
  }

  @Get('groups')
  listGroups(@Param('workspaceId') workspaceId: string, @CurrentTrial() trial: boolean) {
    return this.groups.list(workspaceId, trial);
  }

  @Post('groups')
  createGroup(
    @Param('workspaceId') workspaceId: string,
    @CurrentMembership() membership: { role: Role },
    @Body() body: unknown,
  ) {
    assertCan(membership.role, 'account:manage');
    return this.groups.create(workspaceId, parse(createMatrixGroupSchema, body));
  }

  @Patch('groups/:groupId')
  updateGroup(
    @Param('workspaceId') workspaceId: string,
    @Param('groupId') groupId: string,
    @CurrentMembership() membership: { role: Role },
    @Body() body: unknown,
  ) {
    assertCan(membership.role, 'account:manage');
    return this.groups.update(workspaceId, groupId, parse(updateMatrixGroupSchema, body));
  }

  @Delete('groups/:groupId')
  removeGroup(
    @Param('workspaceId') workspaceId: string,
    @Param('groupId') groupId: string,
    @CurrentMembership() membership: { role: Role },
  ) {
    assertCan(membership.role, 'account:manage');
    return this.groups.remove(workspaceId, groupId);
  }

  @Post('batch')
  @HttpCode(200)
  batchUpdate(
    @Param('workspaceId') workspaceId: string,
    @CurrentMembership() membership: { role: Role },
    @Body() body: unknown,
  ) {
    assertCan(membership.role, 'account:manage');
    return this.groups.batchUpdate(workspaceId, parse(batchAccountsSchema, body));
  }

  @Get('risks')
  @Header('Cache-Control', 'no-store')
  listRisks(@Param('workspaceId') workspaceId: string, @Query('accountId') accountId?: string) {
    return this.risks.listEvents(workspaceId, accountId);
  }

  @Get(':id/operations-summary')
  @Header('Cache-Control', 'no-store')
  async operationsSummary(@Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    const account = await this.prisma.channelAccount.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!account) throw new NotFoundException('账号不存在');
    const [totalTasks, pendingTasks, unknownTasks, latest] = await Promise.all([
      this.prisma.publishTask.count({ where: { workspaceId, accountId: id } }),
      this.prisma.publishTask.count({
        where: { workspaceId, accountId: id, status: { in: ['scheduled', 'dispatching', 'paused', 'handed_off'] } },
      }),
      this.prisma.publishTask.count({ where: { workspaceId, accountId: id, status: 'unknown' } }),
      this.prisma.publishResult.findFirst({
        where: { workspaceId, task: { accountId: id } },
        orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
        select: {
          taskId: true,
          state: true,
          recordedAt: true,
          remoteUrl: true,
          task: { select: { variant: { select: { title: true } } } },
        },
      }),
    ]);
    return {
      accountId: id,
      totalTasks,
      pendingTasks,
      unknownTasks,
      latestResult: latest ? {
        taskId: latest.taskId,
        state: latest.state,
        recordedAt: latest.recordedAt,
        remoteUrl: latest.remoteUrl,
        title: latest.task.variant.title ?? null,
      } : null,
    };
  }

  @Post('password')
  addPassword(
    @Param('workspaceId') workspaceId: string,
    @CurrentMembership() membership: { role: Role },
    @CurrentUser() user: SessionUser,
    @CurrentTrial() trial: boolean,
    @Body() body: unknown,
  ) {
    assertCan(membership.role, 'account:manage');
    if (trial) throw new ConflictException('试用工作室只使用演示账号，请在正式工作室托管账号密码');
    return this.onboarding.addPasswordAccount(workspaceId, user.id, parse(passwordAccountSchema, body));
  }

  @Post('cookie')
  @HttpCode(200)
  importCookie(
    @Param('workspaceId') workspaceId: string,
    @CurrentMembership() membership: { role: Role },
    @CurrentUser() user: SessionUser,
    @CurrentTrial() trial: boolean,
    @Body() body: unknown,
  ) {
    assertCan(membership.role, 'account:manage');
    if (trial) throw new ConflictException('试用工作室只使用演示账号，请在正式工作室导入 Cookie');
    return this.onboarding.importCookieAccount(workspaceId, user.id, parse(cookieImportSchema, body));
  }

  @Post('bilibili/qr')
  startBilibiliQr(
    @Param('workspaceId') workspaceId: string,
    @CurrentMembership() membership: { role: Role },
    @CurrentUser() user: SessionUser,
    @CurrentTrial() trial: boolean,
    @Body() body: unknown,
  ) {
    assertCan(membership.role, 'account:manage');
    if (trial) throw new ConflictException('试用工作室只使用演示账号，请在正式工作室扫码连接 B 站账号');
    const parsed = parse(biliQrStartSchema, body);
    return this.onboarding.startBilibiliWebQr(workspaceId, user.id, parsed?.groupId);
  }

  @Post('bilibili/qr/:id/poll')
  @HttpCode(200)
  pollBilibiliQr(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @CurrentMembership() membership: { role: Role },
    @CurrentUser() user: SessionUser,
  ) {
    assertCan(membership.role, 'account:manage');
    return this.onboarding.pollBilibiliWebQr(workspaceId, user.id, id);
  }

  @Post('demo')
  async addDemo(@Param('workspaceId') workspaceId: string, @CurrentMembership() membership: { role: Role },
    @CurrentTrial() trial: boolean, @Body() body: unknown) {
    assertCan(membership.role, 'account:manage');
    if (!trial || !config.trialAvailable) throw new ConflictException('演示账号只可添加到试用工作室。');
    const { platform, groupId } = parse(demoAccountSchema, body);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
      const validGroupId = await this.groups.assertWorkspaceGroup(tx, workspaceId, groupId);
      const accounts = await tx.channelAccount.findMany({ where: { workspaceId, platform }, select: { displayName: true } });
      const names = new Set(accounts.map(({ displayName }) => displayName));
      let number = accounts.length + 1;
      while (names.has(`演示账号 ${number}`)) number++;
      return tx.channelAccount.create({
        data: {
          workspaceId,
          platform,
          displayName: `演示账号 ${number}`,
          externalId: `trial-${randomUUID()}`,
          channelKind: platform === 'xiaohongshu' ? 'manual' : 'sandbox',
          accessMethod: platform === 'xiaohongshu' ? 'manual_uid' : 'sandbox',
          groupId: validGroupId,
          authStatus: 'active',
          authCheckedAt: new Date(),
        },
        select: { id: true, displayName: true },
      });
    });
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
      bilibiliOAuthOrigin: configuredBilibiliOAuthOrigin,
    };
  }

  @Patch('platform-settings/:platform')
  async savePlatformSettings(
    @Param('workspaceId') workspaceId: string,
    @Param('platform') platformParam: string,
    @CurrentMembership() membership: { role: Role },
    @CurrentUser() user: SessionUser,
    @CurrentTrial() trial: boolean,
    @Body() body: unknown,
  ) {
    assertCan(membership.role, 'workspace:settings');
    if (trial) throw new ConflictException('试用工作室只使用演示账号，请在正式工作室配置平台凭据');
    const platform = parse(platformSchema, platformParam);
    const { appId, appSecret } = parse(appSchema, body);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
      const existing = await workspacePlatformApp(tx, workspaceId, platform);
      const currentAppId = existing?.appId ?? (platform === 'xiaohongshu' ? config.xiaohongshu.appId : config.bilibili.clientId);
      if (currentAppId && currentAppId !== appId && await tx.channelAccount.findFirst({
        where: { workspaceId, platform, externalId: { not: null }, authCheckedAt: { not: null },
          channelKind: platform === 'bilibili' ? 'official' : 'manual' },
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
    @CurrentUser() user: SessionUser, @CurrentTrial() trial: boolean, @Body() body: unknown) {
    assertCan(membership.role, 'account:manage');
    if (trial) throw new ConflictException('试用工作室只使用演示账号');
    if (config.sandboxChannel) throw new ConflictException('当前使用沙箱，请联系部署管理员关闭沙箱后连接真实 B 站账号。');
    const grant = parse(bilibiliGrantSchema, body);
    const app = await readPlatformApp(this.prisma, workspaceId, 'bilibili');
    if (!app && !config.bilibili.enabled) throw new ConflictException('请先在发布账号页保存 B 站开放平台应用凭据。');
    const id = await bindBilibiliAccount(this.prisma, workspaceId, user.id, grant, app);
    return { id };
  }

  @Post('bilibili/authorize')
  authorizeBilibili(@Param('workspaceId') workspaceId: string, @CurrentMembership() membership: { role: Role },
    @CurrentUser() user: SessionUser, @CurrentTrial() trial: boolean, @Headers('origin') origin?: string) {
    assertCan(membership.role, 'account:manage');
    if (trial || config.sandboxChannel) throw new ConflictException('真实 B 站账号授权仅在非沙箱的正式工作室开放。');
    return this.bilibiliOAuth.start(workspaceId, user.id, origin);
  }

  @Post('xiaohongshu/authorize')
  authorizeXiaohongshu(
    @CurrentMembership() membership: { role: Role },
    @CurrentUser() user: SessionUser,
    @CurrentTrial() trial: boolean,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ) {
    assertCan(membership.role, 'account:manage');
    if (trial) throw new ConflictException('试用工作室只使用演示账号');
    return this.xiaohongshu.start(workspaceId, user.id, parse(xhsQrStartSchema, body)?.groupId);
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

  @Post(':id/health-check')
  @HttpCode(200)
  healthCheck(
    @CurrentMembership() membership: { role: Role },
    @CurrentUser() user: SessionUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    assertCan(membership.role, 'account:manage');
    return this.risks.checkAccountHealth(workspaceId, id, user.id, true);
  }

  @Post(':id/risk')
  @HttpCode(200)
  reportRisk(
    @CurrentMembership() membership: { role: Role },
    @CurrentUser() user: SessionUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    assertCan(membership.role, 'task:result');
    const input = parse(reportRiskSchema, body);
    return this.risks.recordRisk({
      workspaceId,
      accountId: id,
      level: input.level,
      kind: input.kind,
      message: input.message,
      actorId: user.id,
      forceNotify: input.forceNotify ?? true,
    });
  }

  @Post(':id/risk/resolve')
  @HttpCode(200)
  resolveRisk(
    @CurrentMembership() membership: { role: Role },
    @CurrentUser() user: SessionUser,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    assertCan(membership.role, 'account:manage');
    const input = parse(resolveRiskSchema, body);
    return this.risks.resolveRisk(workspaceId, id, user.id, input?.note || '人工确认风险已解除', Boolean(input?.notify));
  }

  @Post(':id/read-session')
  @HttpCode(200)
  configureReadSession(
    @CurrentMembership() membership: { role: Role },
    @CurrentTrial() trial: boolean,
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    assertCan(membership.role, 'account:manage');
    if (trial) throw new ConflictException('试用账号不支持配置真实读取会话');
    return this.onboarding.configureReadSession(workspaceId, id, parse(readSessionSchema, body));
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
    const nextEgressIp = input.egressIp !== undefined ? normalizeEgressIp(input.egressIp) : undefined;
    const nextProfileLabel = input.profileLabel !== undefined ? (input.profileLabel?.trim() || null) : undefined;
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.channelAccount.findFirst({ where: { id, workspaceId } });
      if (!existing) throw new NotFoundException('账号不存在');
      const nextProfileUrl = input.profileUrl !== undefined
        ? parseProfileInput(existing.platform, input.profileUrl).profileUrl
        : undefined;
      if (existing.externalId && existing.authCheckedAt && existing.accessMethod !== 'password' && input.displayName !== undefined) {
        throw new ConflictException('已核验账号使用平台昵称。');
      }
      const groupId = input.groupId !== undefined
        ? await this.groups.assertWorkspaceGroup(tx, workspaceId, input.groupId)
        : undefined;
      const updated = await tx.channelAccount.update({
        where: { id },
        data: {
          ...(input.displayName !== undefined && { displayName: input.displayName }),
          ...(input.operator !== undefined && { operator: input.operator }),
          ...(groupId !== undefined && { groupId }),
          ...(input.alias !== undefined && { alias: input.alias?.trim() || null }),
          ...(input.tags !== undefined && { tags: cleanTags(input.tags) }),
          ...(input.pinned !== undefined && { pinned: input.pinned }),
          ...(nextEgressIp !== undefined && { egressIp: nextEgressIp }),
          ...(nextProfileLabel !== undefined && { profileLabel: nextProfileLabel }),
          ...(nextProfileUrl !== undefined && { profileUrl: nextProfileUrl }),
          ...(input.cookieExpiresAt !== undefined && { cookieExpiresAt: input.cookieExpiresAt }),
        },
        select: {
          id: true,
          platform: true,
          channelKind: true,
          externalId: true,
          accessMethod: true,
          displayName: true,
          alias: true,
          operator: true,
          tags: true,
          pinned: true,
          groupId: true,
          group: { select: { id: true, name: true, color: true } },
          egressIp: true,
          profileLabel: true,
          profileUrl: true,
          cookieExpiresAt: true,
        },
      });
      const { externalId: _ext, ...rest } = updated;
      return { ...rest, profileUrl: resolveAccountProfileUrl(updated) };
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
