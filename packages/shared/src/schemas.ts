import { z } from 'zod';
import { CHANNEL_KINDS, PLATFORMS, type JsonValue } from './platform.js';

export const emailSchema = z.string().trim().toLowerCase().email('邮箱格式不对');
export const passwordSchema = z.string().min(8, '密码至少 8 位').max(72);

export const registerSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(1, '名字不能为空').max(40),
  password: passwordSchema,
  workspaceName: z.string().trim().min(1).max(60).optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1),
});

export const createManuscriptSchema = z.object({
  title: z.string().trim().min(1, '标题不能为空').max(200),
  body: z.string().trim().min(1, '正文不能为空').max(50000),
  tags: z.array(z.string().trim().min(1).max(20)).max(30).default([]),
});

export const updateManuscriptSchema = createManuscriptSchema.partial();

export const generateVariantsSchema = z.object({
  platforms: z.array(z.enum(PLATFORMS)).min(1, '至少选一个平台'),
});

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(jsonValueSchema)]),
);

export const updateVariantSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1).max(50000).optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(30).optional(),
  assetIds: z.array(z.string().uuid()).refine((ids) => new Set(ids).size === ids.length, '图片不能重复').optional(),
  coverAssetId: z.string().uuid().nullable().optional(),
  platformFields: z.record(jsonValueSchema).optional(),
}).refine((input) => Object.values(input).some((value) => value !== undefined), '至少提交一项版本内容');

export const createAccountSchema = z.object({
  platform: z.enum(PLATFORMS),
  channelKind: z.enum(CHANNEL_KINDS),
  displayName: z.string().trim().min(1, '账号名不能为空').max(60),
  operator: z.string().trim().max(40).optional(),
  credentials: z.record(z.string()).optional(),
});

export const scheduleTasksSchema = z.object({
  variantIds: z.array(z.string().uuid()).min(1, '至少选一个平台版本'),
  accountIds: z.array(z.string().uuid()).min(1, '至少选一个账号'),
  scheduledAt: z.string().datetime({ offset: true }).pipe(z.coerce.date()),
});

export const recordResultSchema = z.object({
  state: z.enum(['published', 'failed', 'unknown']),
  remoteUrl: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : value),
    z.string().max(2048).url('链接格式不对').refine((value) => {
      const url = URL.canParse(value) ? new URL(value) : null;
      return url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
    }, '作品链接须为 HTTP 或 HTTPS').or(z.literal('')).optional(),
  ),
  remoteId: z.string().trim().max(200).optional(),
  evidenceAssetId: z.string().uuid().optional(),
  note: z.string().trim().max(1000).optional(),
}).refine(
  (result) => result.state !== 'published' || result.remoteUrl || result.evidenceAssetId,
  '已发布须提交作品链接或截图',
);

export const verifyTaskSchema = z.object({
  published: z.boolean(),
  remoteUrl: z.string().trim().url('链接格式不对').optional().or(z.literal('')),
  note: z.string().trim().max(1000).optional(),
});

export const addMemberSchema = z.object({
  email: emailSchema,
  role: z.enum(['owner', 'editor', 'reviewer', 'operator', 'viewer']),
});
