import { AdapterRegistry, ChannelNotConfiguredError, type ChannelAdapter, type PublishInput, type PublishReceipt } from '@matrixark/adapters';
import { BadGatewayException, BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type { ChannelAccount, ChannelKind, Platform, Prisma } from '@prisma/client';
import { resolveAccountCapabilities } from '../../accounts/account-capabilities';
import { isUnverifiedBilibiliAccount } from '../../accounts/publish-account';
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

  requireAvailableAccount(account: ChannelAccount, variant: PublishableVariant, now: Date, trial: boolean) {
    if (isUnverifiedBilibiliAccount(account)) throw new ConflictException(bilibiliAuthorizationRequired);
    if (!account.externalId || !account.authCheckedAt) throw new ConflictException(`账号「${account.displayName}」尚未通过平台身份核验`);
    const { channel } = resolveAccountCapabilities(account, now, trial);
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
