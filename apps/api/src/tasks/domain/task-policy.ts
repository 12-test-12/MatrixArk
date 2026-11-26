import type { PublishReceipt } from '@matrixark/adapters';
import { type PublishInput } from '@matrixark/adapters';
import { COMMITTED_STATUSES } from '@matrixark/shared';
import { ConflictException } from '@nestjs/common';
import { Prisma, type ChannelAccount, type Platform, type PublicationMetrics, type PublishResult, type PublishTask, type TaskStatus } from '@prisma/client';
import { inspectSnapshot, variantSnapshot } from '../../content/content.service';

export const bilibiliAuthorizationRequired = 'B 站账号尚未通过官方授权，请连接已授权账号后重新安排发布';

export const taskRelations = {
  account: { select: { id: true, platform: true, displayName: true, operator: true, channelKind: true, accessMethod: true } },
  variant: { select: { id: true, manuscriptId: true, platform: true, version: true, title: true, videoAssetId: true } },
  result: true,
} as const satisfies Prisma.PublishTaskInclude;

export const publishableVariant = {
  ...variantSnapshot,
  manuscript: { select: { archivedAt: true } },
} as const satisfies Prisma.VariantInclude;

export type PublishableVariant = Prisma.VariantGetPayload<{ include: typeof publishableVariant }>;

export type AutomaticClaim = {
  task: PublishTask;
  variant: PublishableVariant;
  account: ChannelAccount;
  channel: 'official' | 'sandbox';
  leaseId: string;
  trial: boolean;
};

export function hasApproval(variant: PublishableVariant) {
  return !variant.manuscript.archivedAt && variant.status === 'approved'
    && variant.approval?.workspaceId === variant.workspaceId
    && variant.approval.snapshotHash === variant.contentHash
    && inspectSnapshot(variant).issues.length === 0;
}

export function presentTask<T extends PublishTask & { result?: PublishResult | null }>(task: T) {
  const wasDispatched = task.claimedAt || task.handedOffAt || task.attempts > 0 || task.result
    || COMMITTED_STATUSES.includes(task.status);
  const executionChannelStatus = task.executionChannel ? 'known'
    : wasDispatched ? 'historical_unknown' : 'not_dispatched';
  return { ...task, executionChannelStatus, isSandbox: task.executionChannel ? task.executionChannel === 'sandbox' : null };
}

export function assetUrl(workspaceId: string, assetId: string) {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(assetId)}`;
}

export function publishVariant(variant: PublishableVariant): PublishInput['variant'] {
  return {
    ...variant, imageCount: variant.assets.length,
    imageUrls: variant.assets.map(({ assetId }) => assetUrl(variant.workspaceId, assetId))
  };
}

export type TaskFilters = {
  status?: TaskStatus;
  accountId?: string;
  groupId?: string;
  manuscriptId?: string;
  cursor?: string;
  limit: number;
  performance?: true;
  platform?: Platform;
  content?: 'article' | 'video';
  days?: number;
};

export type WorkMetrics = Pick<PublicationMetrics, 'views' | 'likes' | 'comments' | 'favorites' | 'shares'>;

export type WorkMetricsInput = WorkMetrics & { recordedAt?: Date };

export function requirePublishedWork(task: Pick<PublishTask, 'status' | 'executionChannel'>, result: PublishResult | null) {
  if (!result || result.state !== 'published' || task.status !== 'published'
    || (task.executionChannel !== 'official' && task.executionChannel !== 'manual')) {
    throw new ConflictException('只有已确认发布的真实作品可以记录成效');
  }
  return result;
}

export function receiptSnapshot(result: PublishResult | null) {
  return {
    state: result?.state ?? null,
    remoteId: result?.remoteId ?? null,
    remoteUrl: result?.remoteUrl ?? null,
    evidenceAssetId: result?.evidenceAssetId ?? null,
    note: result?.note ?? null,
    recordedById: result?.recordedById ?? null,
    recordedAt: result?.recordedAt.toISOString() ?? null,
    platformPublishedAt: result?.platformPublishedAt?.toISOString() ?? null,
  };
}

export function requireHandoff(task: PublishTask) {
  if (task.status !== 'handed_off' || !task.handedOffAt) {
    throw new ConflictException('仅已交接且未回填的人工任务可以录入结果');
  }
}

export function receiptDetails(receipt: PublishReceipt) {
  return {
    state: receipt.status, remoteId: receipt.remoteId ?? null, remoteUrl: receipt.remoteUrl ?? null,
    ...(receipt.raw ? { platform: receipt.raw as Prisma.InputJsonObject } : {}),
  };
}
