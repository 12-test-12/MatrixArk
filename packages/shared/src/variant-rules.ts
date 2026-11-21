import type { Platform } from './platform.js';

export interface PlatformRule {
  readonly titleMax: number;
  readonly bodyMax: number;
  readonly tagMax: number;
  readonly tagLengthMax: number;
  readonly minImages: number;
  readonly maxImages: number;
  /** 正文末尾是否要带话题块 */
  readonly appendTagsInBody: boolean;
}

/**
 * 首版只覆盖两个平台的硬限制。数值来自各平台发布页的公开限制，
 * 平台改规则时只改这张表，不改业务逻辑。
 */
export const PLATFORM_RULES: Record<Platform, PlatformRule> = {
  bilibili: {
    titleMax: 80,
    bodyMax: 20000,
    tagMax: 10,
    tagLengthMax: 20,
    minImages: 0,
    maxImages: 30,
    appendTagsInBody: false,
  },
  xiaohongshu: {
    titleMax: 20,
    bodyMax: 1000,
    tagMax: 10,
    tagLengthMax: 20,
    minImages: 1,
    maxImages: 9,
    appendTagsInBody: true,
  },
};

export interface ManuscriptInput {
  title: string;
  body: string;
  tags: readonly string[];
}

export interface VariantDraft {
  title: string;
  body: string;
  tags: string[];
}

export interface ValidationIssue {
  field: 'title' | 'body' | 'tags' | 'images' | 'snapshot';
  code: string;
  message: string;
}

const HASHTAG_RE = /#([\p{L}\p{N}_]{1,20})/gu;

function toChars(value: string): string[] {
  return Array.from(value);
}

export function truncate(value: string, max: number): string {
  const chars = toChars(value);
  if (chars.length <= max) return value;
  if (max <= 1) return chars.slice(0, max).join('');
  return `${chars.slice(0, max - 1).join('')}…`;
}

/** 从正文里扒出已有话题，避免和小红书自带的话题块重复 */
export function extractHashtags(body: string): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(HASHTAG_RE)) {
    const tag = match[1];
    if (tag) found.push(tag);
  }
  return found;
}

export function normalizeTags(tags: readonly string[], extra: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of [...tags, ...extra]) {
    const tag = raw.replace(/^#/, '').trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
}

/** 去掉正文里的话题块，交给 appendTagsInBody 统一重排 */
function stripTrailingHashtags(body: string): string {
  return body.replace(/(?:\s*#[\p{L}\p{N}_]{1,20})+\s*$/u, '').trimEnd();
}

/**
 * 一条原稿 → 一个平台版本。纯函数，没有模型也能跑；
 * LLM 改写以后作为可选步骤接在它后面，不替换它。
 */
export function generateVariantDraft(manuscript: ManuscriptInput, platform: Platform): VariantDraft {
  const rule = PLATFORM_RULES[platform];
  const detected = extractHashtags(manuscript.body);
  const tags = normalizeTags(manuscript.tags, detected).slice(0, rule.tagMax);

  const title = truncate(manuscript.title.trim(), rule.titleMax);
  let body = manuscript.body.trim();

  if (rule.appendTagsInBody) {
    body = stripTrailingHashtags(body);
    const suffix = tags.map((tag) => `#${tag}`).join(' ');
    const room = Math.max(0, rule.bodyMax - (suffix ? suffix.length + 2 : 0));
    body = truncate(body, room);
    body = suffix ? `${body}\n\n${suffix}` : body;
  } else {
    body = truncate(body, rule.bodyMax);
  }

  return { title, body, tags };
}

export function validateVariant(
  platform: Platform,
  input: { title: string; body: string; tags: readonly string[]; imageCount: number },
): ValidationIssue[] {
  const rule = PLATFORM_RULES[platform];
  const issues: ValidationIssue[] = [];

  if (!input.title.trim()) {
    issues.push({ field: 'title', code: 'title_empty', message: '标题不能为空' });
  }
  if (toChars(input.title).length > rule.titleMax) {
    issues.push({
      field: 'title',
      code: 'title_too_long',
      message: `标题超过 ${rule.titleMax} 字（当前 ${toChars(input.title).length} 字）`,
    });
  }
  if (!input.body.trim()) {
    issues.push({ field: 'body', code: 'body_empty', message: '正文不能为空' });
  }
  if (toChars(input.body).length > rule.bodyMax) {
    issues.push({
      field: 'body',
      code: 'body_too_long',
      message: `正文超过 ${rule.bodyMax} 字（当前 ${toChars(input.body).length} 字）`,
    });
  }
  if (input.tags.length > rule.tagMax) {
    issues.push({
      field: 'tags',
      code: 'tags_too_many',
      message: `话题超过 ${rule.tagMax} 个`,
    });
  }
  for (const tag of input.tags) {
    if (toChars(tag).length > rule.tagLengthMax) {
      issues.push({
        field: 'tags',
        code: 'tag_too_long',
        message: `话题「${truncate(tag, 8)}」超过 ${rule.tagLengthMax} 字`,
      });
      break;
    }
  }
  if (input.imageCount < rule.minImages) {
    issues.push({
      field: 'images',
      code: 'images_missing',
      message: `${platform === 'xiaohongshu' ? '小红书' : '该平台'}至少需要 ${rule.minImages} 张图片`,
    });
  }
  if (input.imageCount > rule.maxImages) {
    issues.push({
      field: 'images',
      code: 'images_too_many',
      message: `图片超过 ${rule.maxImages} 张，多出的需人工取舍`,
    });
  }

  return issues;
}
