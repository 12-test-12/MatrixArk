import { createHash } from 'node:crypto';

/** 平台标识：首版只有这两个，其余等真实客户提出再加 */
export const PLATFORMS = ['bilibili', 'xiaohongshu'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  bilibili: 'B 站专栏',
  xiaohongshu: '小红书',
};

/** 账号通道类型：官方直发 / 人工交接 / 沙箱（无权限时联调用） */
export const CHANNEL_KINDS = ['official', 'manual', 'sandbox'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const CHANNEL_KIND_LABELS: Record<ChannelKind, string> = {
  official: '官方直发',
  manual: '人工交接',
  sandbox: '沙箱联调',
};

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

/**
 * 内容指纹：版本内容一变，指纹就变。幂等键依赖它，
 * 保证「改稿后重发」与「同稿重复提交」被区别对待。
 */
export function contentHash(input: {
  platform: Platform;
  title: string;
  body: string;
  tags: readonly string[];
}): string {
  const payload = JSON.stringify({
    platform: input.platform,
    title: input.title.trim(),
    body: input.body.trim(),
    tags: [...input.tags],
  });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * 幂等键：同一账号 + 同一版本 + 同一时间点，只允许发布一次。
 * 提交前用它抢锁，数据库唯一索引兜底。
 */
export function idempotencyKey(input: {
  accountId: string;
  variantId: string;
  hash: string;
  scheduledAt: Date | string;
}): string {
  const slot = new Date(input.scheduledAt).toISOString().slice(0, 16); // 分钟精度
  return createHash('sha256')
    .update([input.accountId, input.variantId, input.hash, slot].join('|'))
    .digest('hex');
}
