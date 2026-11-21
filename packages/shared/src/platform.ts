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

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };

function stableStringify(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const fields: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const field = value[key];
    if (field !== undefined) fields.push(`${JSON.stringify(key)}:${stableStringify(field)}`);
  }
  return `{${fields.join(',')}}`;
}

/** 完整发布快照的指纹，旧版本的指纹保持入库时的值。 */
export function contentHash(input: {
  platform: Platform;
  title: string;
  body: string;
  tags: readonly string[];
  assets: readonly { assetId: string; position: number; isCover: boolean }[];
  platformFields: JsonValue;
  videoAssetId?: string | null;
}): string {
  const payload = stableStringify({
    platform: input.platform,
    title: input.title.trim(),
    body: input.body.trim(),
    tags: [...input.tags],
    assets: [...input.assets].sort((a, b) => a.position - b.position).map(
      ({ assetId, position, isCover }) => ({ assetId, position, isCover }),
    ),
    platformFields: input.platformFields,
    ...(input.videoAssetId ? { videoAssetId: input.videoAssetId } : {}),
  });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * 幂等键固定在账号、版本及内容快照上，调整计划时间时沿用任务原键。
 */
export function idempotencyKey(input: {
  accountId: string;
  variantId: string;
  hash: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([input.accountId, input.variantId, input.hash]))
    .digest('hex');
}
