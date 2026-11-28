import { AdapterRegistry, ChannelNotConfiguredError, type ChannelAdapter, type PublishInput, type PublishReceipt } from '@matrixark/adapters';
import { BadGatewayException, BadRequestException, ConflictException, Inject, Injectable, Optional } from '@nestjs/common';
import { PUBLISH_MODES } from '@matrixark/shared';
import type { ChannelAccount, ChannelKind, Platform, Prisma } from '@prisma/client';
import { resolveAccountCapabilities } from '../../accounts/account-capabilities';
import { extractBilibiliUid, isUnverifiedBilibiliAccount } from '../../accounts/publish-account';
import { LocalBrowserProfiles } from '../../accounts/local-browser-profiles';
import { PrismaService } from '../../prisma/prisma.service';
import { config } from '../../config';
import { type AutomaticClaim, bilibiliAuthorizationRequired, type PublishableVariant, publishVariant } from '../domain/task-policy';
import { databaseTime } from './task-locks';
import { PUBLISHING_PLATFORMS, type PublishingPlatform } from './publishing-platform';

@Injectable()
export class TaskPlatformService {
  private readonly platforms = new Map<Platform, PublishingPlatform>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: AdapterRegistry,
    @Inject(PUBLISHING_PLATFORMS) platforms: readonly PublishingPlatform[],
    @Optional() private readonly profiles?: LocalBrowserProfiles,
  ) {
    for (const platform of platforms) {
      if (this.platforms.has(platform.platform)) throw new Error(`发布平台重复注册：${platform.platform}`);
      this.platforms.set(platform.platform, platform);
    }
  }

  private platform(platform: Platform) {
    const implementation = this.platforms.get(platform);
    if (!implementation) throw new ChannelNotConfiguredError(`平台 ${platform} 暂无官方通道实现`);
    return implementation;
  }

  supportsContent(platform: Platform, channel: ChannelKind, variant: Pick<PublishableVariant, 'videoAssetId'>) {
    return this.adapters.has(platform, channel)
      && (!variant.videoAssetId || this.adapters.registration(platform, channel).contentPolicy.supportsVideo);
  }

  supportsMetrics(platform: Platform, channel: ChannelKind | null, variant: Pick<PublishableVariant, 'videoAssetId'>) {
    return Boolean(channel && this.supportsContent(platform, channel, variant)
      && this.adapters.registration(platform, channel).supportsMetrics);
  }

  dispatchScope(): Prisma.PublishTaskWhereInput {
    return {
      ...(!config.trialAvailable && { workspace: { trialOwnerId: null } }),
      OR: [
        { selectedMode: { in: ['manual_handoff', 'local_browser'] }, OR: [{ executionChannel: null }, { executionChannel: 'manual' }] },
        { account: { channelKind: 'manual' }, executionChannel: { in: ['manual'] } },
        { account: { channelKind: 'manual' }, executionChannel: null },
        ...[...this.platforms.values()].flatMap(platform => platform.dispatchScope()),
        ...(config.sandboxChannel || config.trialAvailable ? [{
          ...(!config.sandboxChannel && { workspace: { trialOwnerId: { not: null } } }),
          account: { channelKind: 'sandbox' as const },
          OR: [{ executionChannel: null }, { executionChannel: 'sandbox' as const }],
        }] : []),
      ],
    };
  }

  receiptScope(): Prisma.PublishTaskWhereInput {
    return {
      ...(!config.trialAvailable && { workspace: { trialOwnerId: null } }),
      account: { platform: { in: [...this.platforms.keys()] } },
      OR: [
        ...[...this.platforms.values()].flatMap(platform => platform.receiptScope()),
        ...(config.sandboxChannel || config.trialAvailable ? [{
          executionChannel: 'sandbox' as const,
          ...(!config.sandboxChannel && { workspace: { trialOwnerId: { not: null } } }),
        }] : []),
      ],
    };
  }

  metricsScope(now: Date): Prisma.PublishTaskWhereInput {
    return { OR: [...this.platforms.values()]
      .filter(platform => this.adapters.registration(platform.platform, 'official').supportsMetrics)
      .map(platform => platform.metricsScope(now)) };
  }

  validateRemoteId(platform: Platform, remoteId: string) {
    this.platform(platform).validateRemoteId(remoteId);
  }

  channelFor(account: ChannelAccount, now: Date, trial: boolean, mode?: string | null): ChannelKind | undefined {
    const capabilities = resolveAccountCapabilities(account, now, trial);
    if (!mode) return capabilities.channel;
    if (mode === 'official_api') return capabilities.channel === 'official' ? 'official' : undefined;
    if (mode === 'sandbox') return capabilities.channel === 'sandbox' ? 'sandbox' : undefined;
    if (!['manual_handoff', 'local_browser'].includes(mode) || !capabilities.identityVerified || trial
      || account.archivedAt || (account.rateLimitedUntil && account.rateLimitedUntil > now)) return;
    if (mode === 'local_browser' && (account.platform !== 'bilibili' || account.channelKind !== 'manual'
      || !extractBilibiliUid(account.externalId))) return;
    return 'manual';
  }

  requireAvailableAccount(account: ChannelAccount, variant: PublishableVariant, now: Date, trial: boolean, mode?: string | null) {
    if (isUnverifiedBilibiliAccount(account)) throw new ConflictException(bilibiliAuthorizationRequired);
    if (!account.externalId || !account.authCheckedAt) throw new ConflictException(`账号「${account.displayName}」尚未通过平台身份核验`);
    if (account.archivedAt) throw new ConflictException('账号已归档，请先恢复账号');
    if (account.rateLimitedUntil && account.rateLimitedUntil > now) throw new ConflictException('账号处于平台限流期，请等待限流结束');
    if (mode === 'local_browser' && (account.platform !== 'bilibili' || account.channelKind !== 'manual'
      || !extractBilibiliUid(account.externalId))) throw new ConflictException('浏览器辅助需要已核验的 B 站 UID 账号；OAuth openid 暂不能关联浏览器');
    if (mode === 'official_api') {
      if (account.channelKind !== 'official') throw new ConflictException('该账号尚未连接官方 OAuth 授权');
      if (!this.supportsContent(account.platform, 'official', variant)) throw new ConflictException('当前官方 Adapter 未实现视频投稿，请选择浏览器辅助或人工交接');
      if (account.authStatus !== 'active' || !account.authExpiresAt || account.authExpiresAt <= now) throw new ConflictException('官方授权已失效或停用，请重新授权');
      if (!account.authScope.includes('ATC_BASE') || !account.authScope.includes('ATC_DATA')) throw new ConflictException('官方授权缺少 ATC_BASE / ATC_DATA Scope');
    }
    if (mode === 'sandbox' && account.channelKind !== 'sandbox') throw new ConflictException('沙箱方式仅供沙箱账号模拟，不会真实投稿');
    const channel = this.channelFor(account, now, trial, mode);
    if (!channel) throw new ConflictException(`账号「${account.displayName}」当前不可排期，请检查授权和通道配置`);
    const { contentPolicy } = this.adapters.registration(account.platform, channel);
    if (!this.supportsContent(account.platform, channel, variant)) {
      throw new ConflictException('视频官方投稿未开通，请选择人工交接或沙箱账号');
    }
    if (channel === 'official' && !this.platform(account.platform).credentials(account)) {
      throw new ConflictException(this.platform(account.platform).errors.unreadableCredentials);
    }
    try {
      contentPolicy.validate(publishVariant(variant));
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    return channel;
  }

  async requireReady(tx: Prisma.TransactionClient, account: ChannelAccount, variant: PublishableVariant,
    now: Date, trial: boolean, mode?: string | null, taskId?: string) {
    const channel = this.requireAvailableAccount(account, variant, now, trial, mode);
    // 旧客户端继续由 Worker 检查应用；显式选择方式时在创建前完成预检。
    if (mode) await this.requireApplication(tx, account, channel);
    if (mode === 'local_browser') {
      if (!this.profiles) throw new ConflictException('本地浏览器未启用');
      // 预检只看“该账号有已核验 Profile”，不限制当前开着哪个账号的窗口；真正打开时才决定是否切换。
      await this.profiles.requireVerified(account.workspaceId, account.id, extractBilibiliUid(account.externalId)!,
        { allowSwitch: true });
    }
    if (mode && await tx.publishTask.findFirst({ where: {
      accountId: account.id, ...(taskId && { id: { not: taskId } }),
      status: { in: ['dispatching', 'handed_off', 'unknown', 'submitted', 'under_review'] },
    }, select: { id: true } })) throw new ConflictException('该账号有未完成的发布任务，请先核对并回填原任务结果');
    return channel;
  }

  async publishOptions(tx: Prisma.TransactionClient, account: ChannelAccount, variant: PublishableVariant, now: Date, trial: boolean) {
    const existing = await tx.publishTask.findFirst({ where: { accountId: account.id, variantId: variant.id }, select: { id: true } });
    if (existing) return { accountId: account.id, variantId: variant.id, recommended: null, existingTaskId: existing.id,
      modes: PUBLISH_MODES.map((mode) => ({ mode, available: false, reason: '该账号与版本已有任务，请查看原任务，避免重复发布' })) };
    const modes = await Promise.all(PUBLISH_MODES.map(async (mode) => {
      try {
        await this.requireReady(tx, account, variant, now, trial, mode);
        return { mode, available: true, reason: null };
      } catch (error) {
        if (!(error instanceof ConflictException || error instanceof BadRequestException)) throw error;
        return { mode, available: false, reason: error.message };
      }
    }));
    return { accountId: account.id, variantId: variant.id, recommended: modes.find((mode) => mode.available)?.mode ?? null, modes };
  }

  async requireApplication(tx: Prisma.TransactionClient, account: ChannelAccount, channel: ChannelKind) {
    if (channel !== 'official') return;
    const platform = this.platform(account.platform);
    if (!await platform.options(tx, account).catch(() => undefined)) throw new ConflictException(platform.errors.unavailableApplication);
  }

  async applicationReady(tx: Prisma.TransactionClient, account: ChannelAccount, channel: ChannelKind | undefined) {
    return channel !== 'official' || this.platform(account.platform).applicationReady(tx, account);
  }

  async createExecution({ task, variant, account, channel, trial }: AutomaticClaim, beforeSubmit: NonNullable<PublishInput['beforeSubmit']>) {
    const platform = channel === 'official' ? this.platform(account.platform) : undefined;
    const options = await platform?.options(this.prisma, account).catch(() => undefined);
    const adapter = this.adapters.resolve(account.platform, channel, { ...options, trial, forceSandbox: trial });
    const input: PublishInput = {
      variant: publishVariant(variant),
      account: { ...account, credentials: platform?.credentials(account) },
      slot: { scheduledAt: task.scheduledAt.toISOString(), idempotencyKey: task.idempotencyKey },
      beforeSubmit,
    };
    return { adapter, input };
  }

  async preflight(adapter: ChannelAdapter, input: PublishInput, claim: AutomaticClaim) {
    const { contentPolicy } = this.adapters.registration(claim.account.platform, adapter.kind);
    if (contentPolicy.requiresImageFiles) {
      const platform = this.platform(claim.account.platform);
      if (!platform.prepareImages) throw new ChannelNotConfiguredError('平台未配置投稿图片准备能力');
      input.variant.images = await platform.prepareImages(claim.variant);
    }
    contentPolicy.validate(input.variant);
    await adapter.preflight(input);
  }

  async fetchMetrics(account: ChannelAccount, remoteId: string) {
    const platform = this.platform(account.platform);
    const credentials = platform.credentials(account);
    if (!credentials || !resolveAccountCapabilities(account, await databaseTime(this.prisma)).availableForMetrics) {
      throw new ConflictException(platform.errors.unavailableAuthorization);
    }
    const options = await platform.options(this.prisma, account);
    if (!options) throw new ConflictException(platform.errors.missingApplication);
    const adapter = this.adapters.resolve(account.platform, 'official', options);
    if (!adapter.fetchMetrics) throw new ConflictException('此作品暂不支持同步平台数据，可以手动录入');
    const metrics = await adapter.fetchMetrics(remoteId, { credentials });
    if (!metrics) throw new BadGatewayException(platform.errors.missingMetrics);
    return metrics;
  }

  async fetchStatus(account: ChannelAccount, executionChannel: ChannelKind, trial: boolean, receipt: PublishReceipt, now: Date) {
    if (resolveAccountCapabilities(account, now, trial).channel !== executionChannel) return;
    const platform = executionChannel === 'official' ? this.platform(account.platform) : undefined;
    const credentials = platform?.credentials(account);
    if (platform && !credentials) return;
    const options = await platform?.options(this.prisma, account).catch(() => undefined);
    if (platform && !options) return;
    const adapter = this.adapters.resolve(account.platform, executionChannel, { ...options, trial });
    return adapter.fetchStatus(receipt, { ...account, credentials });
  }
}
