import type { ChannelKind, Platform } from '@matrixark/shared';

/** 提交后平台可能给出的结果。与任务状态机的前半段一一对应。 */
export type ReceiptStatus = 'handed_off' | 'submitted' | 'under_review' | 'published' | 'failed' | 'unknown';

export interface PublishInput {
  variant: {
    id: string;
    platform: Platform;
    title: string;
    body: string;
    tags: readonly string[];
    imageUrls: readonly string[];
    platformFields?: unknown;
    images?: readonly { file: Blob; isCover: boolean }[];
    imageCount?: number;
  };
  account: {
    id: string;
    platform: Platform;
    channelKind: ChannelKind;
    displayName: string;
    externalId?: string | null;
    credentials?: Record<string, string> | null;
  };
  slot: {
    scheduledAt: string;
    idempotencyKey: string;
  };
  beforeSubmit?: () => Promise<boolean>;
}

export interface PublishReceipt {
  status: ReceiptStatus;
  /** 平台侧 id，查状态与回填都要用 */
  remoteId?: string;
  remoteUrl?: string;
  message?: string;
  raw?: unknown;
  platformPublishedAt?: string;
}

export interface PublishMetrics {
  views: number | null;
  likes: number | null;
  comments: number | null;
  favorites: number | null;
  shares: number | null;
}

export interface PlatformContentPolicy {
  readonly supportsVideo: boolean;
  readonly requiresImageFiles: boolean;
  validate(variant: PublishInput['variant']): void;
}

/** 通道未配置好：不是业务失败，是环境问题，不能算成「发布失败」 */
export class ChannelNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelNotConfiguredError';
  }
}

export interface ChannelAdapter {
  readonly kind: ChannelKind;
  readonly platforms: readonly Platform[];
  /** 发布前的平台侧校验（账号权限、字段限制），与本地规则校验互补 */
  preflight(input: PublishInput): Promise<void>;
  publish(input: PublishInput): Promise<PublishReceipt>;
  /** 待核实任务的唯一合法出口：去平台问一次到底发没发 */
  fetchStatus(receipt: PublishReceipt, account: PublishInput['account']): Promise<PublishReceipt>;
  fetchMetrics?(remoteId: string, account: Pick<PublishInput['account'], 'credentials'>): Promise<PublishMetrics | undefined>;
}
