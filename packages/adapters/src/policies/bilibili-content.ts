import type { PlatformContentPolicy, PublishInput } from '../types.js';

const receiptIdPattern = /^[1-9]\d{0,19}$/;

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function articleId(value: unknown) {
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isSafeInteger(value))) return undefined;
  return receiptIdPattern.test(String(value)) ? String(value) : undefined;
}

export function articleFields(variant: PublishInput['variant']) {
  const fields = record(variant.platformFields);
  const category = articleId(fields.category);
  const summary = typeof fields.summary === 'string' ? fields.summary.trim() : '';
  const bodyLength = [...variant.body.trim()].length;
  if (!category) throw new Error('请选择 B 站专栏子分类');
  if ([...variant.title.trim()].length < 1 || [...variant.title.trim()].length > 40) {
    throw new Error('B 站专栏标题须为 1–40 字');
  }
  if ([...summary].length < 200) throw new Error('B 站专栏摘要至少需要 200 字');
  if (bodyLength > 40_000 || (bodyLength < 200 && (variant.imageCount ?? variant.images?.length ?? 0) < 3)) {
    throw new Error('B 站专栏正文须为 200–40,000 字，不足 200 字时至少需要三张图片');
  }
  return { category, summary };
}

export function validateBilibiliArticle(variant: PublishInput['variant']) {
  articleFields(variant);
}

export const bilibiliArticlePolicy: PlatformContentPolicy = {
  supportsVideo: false,
  requiresImageFiles: true,
  validate: validateBilibiliArticle,
};
