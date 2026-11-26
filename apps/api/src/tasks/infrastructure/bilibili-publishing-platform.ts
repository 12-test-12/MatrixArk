import { BadRequestException, Injectable } from '@nestjs/common';
import type { ChannelAccount, Prisma } from '@prisma/client';
import { platformKeyId } from '../../accounts/platform-app';
import { bilibiliAppOptions, bilibiliCredentials } from '../../accounts/publish-account';
import { StorageService } from '../../content/storage.service';
import { PrismaService } from '../../prisma/prisma.service';
import { config } from '../../config';
import type { PublishableVariant } from '../domain/task-policy';
import type { PublishingPlatform } from './publishing-platform';

@Injectable()
export class BilibiliPublishingPlatform implements PublishingPlatform {
  readonly platform = 'bilibili' as const;
  readonly errors = {
    unreadableCredentials: '无法读取该账号的 B 站授权',
    unavailableAuthorization: 'B 站账号授权当前不可用，请重新连接账号或手动录入',
    unavailableApplication: 'B 站开放平台应用凭据不可用，请负责人重新保存',
    missingApplication: '请先配置 B 站开放平台应用凭据',
    missingMetrics: 'B 站未返回成效数据，请检查接口权限后重试',
  };

  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService) {}

  credentials(account: ChannelAccount) {
    return bilibiliCredentials(account);
  }

  async options(tx: Prisma.TransactionClient, account: ChannelAccount) {
    const bilibili = await bilibiliAppOptions(tx, account);
    return bilibili ? { bilibili } : undefined;
  }

  async applicationReady(tx: Prisma.TransactionClient, account: ChannelAccount) {
    return account.credentialsKeyId !== platformKeyId || Boolean(await this.options(tx, account).catch(() => undefined));
  }

  dispatchScope(): Prisma.PublishTaskWhereInput[] {
    return config.sandboxChannel ? [] : [{
      workspace: { trialOwnerId: null },
      account: { channelKind: 'official', ...(config.bilibili.enabled ? {} : { credentialsKeyId: platformKeyId }) },
      OR: [{ executionChannel: null }, { executionChannel: 'official' }],
    }];
  }

  receiptScope(): Prisma.PublishTaskWhereInput[] {
    return config.sandboxChannel ? [] : [{
      workspace: { trialOwnerId: null }, executionChannel: 'official',
      ...(config.bilibili.enabled ? {} : { account: { platform: 'bilibili', credentialsKeyId: platformKeyId } }),
    }];
  }

  metricsScope(now: Date): Prisma.PublishTaskWhereInput {
    return {
      variant: { platform: 'bilibili', videoAssetId: null },
      account: { authStatus: 'active', archivedAt: null, authExpiresAt: { gt: now },
        authScope: { hasEvery: ['ATC_BASE', 'ATC_DATA'] },
        OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lte: now } }] },
    };
  }

  validateRemoteId(remoteId: string) {
    if (!/^[1-9]\d{0,19}$/u.test(remoteId)) throw new BadRequestException('请填写有效的 B 站文章 ID');
  }

  async prepareImages(variant: PublishableVariant) {
    const { workspaceId, manuscriptId, assets } = variant;
    const files = await this.prisma.asset.findMany({
      where: { id: { in: assets.map(({ assetId }) => assetId) }, workspaceId, manuscriptId, kind: 'manuscript_image' },
      select: { id: true, storageKey: true, size: true },
    });
    const byId = new Map(files.map((file) => [file.id, file]));
    const images: { file: Blob; isCover: boolean }[] = [];
    for (const asset of assets) {
      const file = byId.get(asset.assetId);
      if (!file || file.size > 5 * 1024 * 1024) throw new Error('文章图片缺失或超出 B 站大小限制');
      const image = await this.storage.readImage(workspaceId, file.storageKey);
      images.push({ file: new Blob([new Uint8Array(image.data)], { type: image.mimeType }), isCover: asset.isCover });
    }
    return images;
  }
}
