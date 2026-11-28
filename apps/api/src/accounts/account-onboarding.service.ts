import { createHash, randomUUID } from 'node:crypto';
import {
  assertQrTransition,
  canQrTransition,
  QR_STATE_MESSAGES,
  toLegacyQrStatus,
  type QrBusinessState,
  type QrLoginState,
  type QrPollResult,
} from '@matrixark/shared';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import {
  cleanTags,
  encryptAccountSecret,
  maskLoginIdentifier,
  normalizeEgressIp,
  parseCookieHeader,
  validatePlatformCookie,
} from './account-secrets';
import { MatrixGroupsService } from './matrix-groups.service';
import { decryptPlatformSecret, encryptPlatformSecret, platformKeyId } from './platform-app';
import { bilibiliManualUidPrefix, bilibiliWebUidPrefix, parseProfileInput } from './publish-account';

const BILI_QR_TTL_MS = 180_000;
const BILI_POLL_INTERVAL_MS = 1500;
const BILI_POLL_LOCK_MS = 25_000;
const BILI_TERMINAL_RETENTION_MS = 10 * 60_000;

const biliWebHeaders = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9',
  referer: 'https://www.bilibili.com/',
  origin: 'https://www.bilibili.com',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
} as const;

const qrGenerateResponseSchema = z.object({
  code: z.literal(0),
  data: z.object({
    url: z.string().url(),
    qrcode_key: z.string().min(1).max(256),
  }),
});

const qrPollResponseSchema = z.object({
  code: z.literal(0),
  data: z.object({
    url: z.string().nullish(),
    code: z.number().int(),
    message: z.string().nullish(),
  }),
});

const biliNavResponseSchema = z.object({
  code: z.number().int(),
  data: z.object({
    isLogin: z.boolean().nullish(),
    mid: z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d{0,19}$/)]).nullish(),
    uname: z.string().nullish(),
  }).nullish(),
});

export const passwordAccountSchema = z.object({
  platform: z.enum(['xiaohongshu', 'bilibili']),
  displayName: z.string().trim().min(1, '请填写账号显示名称').max(60),
  loginIdentifier: z.string().trim().min(1, '请填写登录账号（手机号 / 邮箱 / 用户名）').max(120),
  password: z.string().min(1, '请填写登录密码').max(256),
  profile: z.string().trim().max(1000).optional(),
  profileUrl: z.string().trim().max(1000).nullable().optional(),
  operator: z.string().trim().max(40).optional(),
  groupId: z.string().min(1).nullable().optional(),
  alias: z.string().trim().max(60).optional(),
  tags: z.array(z.string().trim().min(1).max(24)).max(12).optional(),
  egressIp: z.string().trim().max(64).nullable().optional(),
  profileLabel: z.string().trim().max(64).nullable().optional(),
}).strict();

export const cookieImportSchema = z.object({
  platform: z.enum(['xiaohongshu', 'bilibili']),
  cookie: z.string().trim().min(1, '请粘贴 Cookie 内容').max(32_768),
  accountId: z.string().min(1).optional(),
  displayName: z.string().trim().max(60).optional(),
  profileUrl: z.string().trim().max(1000).nullable().optional(),
  operator: z.string().trim().max(40).optional(),
  groupId: z.string().min(1).nullable().optional(),
  alias: z.string().trim().max(60).optional(),
  tags: z.array(z.string().trim().min(1).max(24)).max(12).optional(),
  cookieExpiresAt: z.string().datetime({ offset: true }).transform((v) => new Date(v)).nullable().optional(),
  egressIp: z.string().trim().max(64).nullable().optional(),
  profileLabel: z.string().trim().max(64).nullable().optional(),
}).strict();

export const readSessionSchema = z.object({
  readAccountId: z.string().min(1).nullable().optional(),
  readCookie: z.string().trim().max(32_768).nullable().optional(),
  readCookieLabel: z.string().trim().max(60).nullable().optional(),
}).strict();

function splitCombinedSetCookieHeader(raw: string): string[] {
  // Split combined Set-Cookie header only at boundaries before "<name>=" (ignoring commas inside Expires=Wed, ...)
  return raw.split(/,(?=\s*[^;=,\s]+=)/g).map((part) => part.trim()).filter(Boolean);
}

export function extractCookiesFromResponse(response: Response, callbackUrl?: string | null) {
  const entries: Record<string, string> = {};
  let setCookies: string[] = [];
  if (typeof response.headers.getSetCookie === 'function') {
    setCookies = response.headers.getSetCookie();
  }
  if (!setCookies.length) {
    const rawHeader = response.headers.get('set-cookie');
    if (rawHeader) setCookies = splitCombinedSetCookieHeader(rawHeader);
  }
  for (const raw of setCookies) {
    const first = raw.split(';')[0]?.trim();
    if (!first) continue;
    const eq = first.indexOf('=');
    if (eq > 0) {
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (name && value) entries[name] = value;
    }
  }
  if (callbackUrl && URL.canParse(callbackUrl)) {
    const parsed = new URL(callbackUrl);
    for (const key of ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid', 'bili_ticket']) {
      const val = parsed.searchParams.get(key)?.trim();
      if (val && !entries[key]) entries[key] = val;
    }
  }
  return {
    cookieHeader: Object.entries(entries).map(([k, v]) => `${k}=${v}`).join('; '),
    hasSessdata: Boolean(entries.SESSDATA),
    hasBiliJct: Boolean(entries.bili_jct),
    hasDedeUserId: Boolean(entries.DedeUserID),
  };
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error';
  return typeof error;
}

type NavProbeOutcome =
  | { kind: 'ok'; mid: string; uname: string }
  | { kind: 'invalid'; message: string; biliCode?: number }
  | { kind: 'rate_limited'; httpStatus: number }
  | { kind: 'timeout'; durationMs: number }
  | { kind: 'network'; errorType: string; durationMs: number }
  | { kind: 'upstream_http'; httpStatus: number; durationMs: number }
  | { kind: 'invalid_json'; durationMs: number };

@Injectable()
export class AccountOnboardingService {
  private readonly logger = new Logger(AccountOnboardingService.name);
  private readonly startingBiliQr = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly groups: MatrixGroupsService,
  ) {}

  private buildQrResult(params: {
    id: string;
    state: QrLoginState;
    businessState: QrBusinessState;
    code: number | null;
    expiresAt: number;
    message?: string;
    retryAfterMs?: number;
    accountId?: string | null;
    canRetry?: boolean;
  }): QrPollResult {
    return {
      id: params.id,
      state: params.state,
      businessState: params.businessState,
      status: toLegacyQrStatus(params.state, params.businessState),
      code: params.code,
      message: params.message ?? QR_STATE_MESSAGES[params.state],
      expiresAt: params.expiresAt,
      ...(params.retryAfterMs !== undefined && { retryAfterMs: params.retryAfterMs }),
      ...(params.accountId ? { accountId: params.accountId } : {}),
      ...(params.canRetry !== undefined && { canRetry: params.canRetry }),
    };
  }

  private async cleanupQrTickets(workspaceId: string, userId: string, now: Date) {
    const retentionCutoff = new Date(now.getTime() - BILI_TERMINAL_RETENTION_MS);
    await this.prisma.bilibiliQrTicket.deleteMany({
      where: {
        OR: [
          { expiresAt: { lte: retentionCutoff } },
          {
            workspaceId,
            userId,
            state: { in: ['CONNECTED', 'QR_EXPIRED', 'CANCELED'] },
            updatedAt: { lte: retentionCutoff },
          },
        ],
      },
    });
  }

  private async probeBilibiliNavCookie(cookieHeader: string): Promise<NavProbeOutcome> {
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        headers: {
          ...biliWebHeaders,
          cookie: cookieHeader,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (isTimeoutError(error)) return { kind: 'timeout', durationMs };
      return { kind: 'network', errorType: errorName(error), durationMs };
    }
    const durationMs = Date.now() - startedAt;
    if (response.status === 429 || response.status === 412) {
      return { kind: 'rate_limited', httpStatus: response.status };
    }
    if (!response.ok) {
      return { kind: 'upstream_http', httpStatus: response.status, durationMs };
    }
    const json = await response.json().catch(() => null);
    const parsed = biliNavResponseSchema.safeParse(json);
    if (!parsed.success) {
      return { kind: 'invalid_json', durationMs };
    }
    if (parsed.data.code === -412 || parsed.data.code === -509 || parsed.data.code === -799) {
      return { kind: 'rate_limited', httpStatus: response.status };
    }
    if (parsed.data.code === -101 || !parsed.data.data?.isLogin || !parsed.data.data.mid) {
      return {
        kind: 'invalid',
        biliCode: parsed.data.code,
        message: 'B 站 Cookie 无效或尚未通过登录核验，请重新扫码或确认已复制最新的 SESSDATA',
      };
    }
    return {
      kind: 'ok',
      mid: String(parsed.data.data.mid),
      uname: parsed.data.data.uname?.trim() || `B站用户 ${parsed.data.data.mid}`,
    };
  }

  private async verifyBilibiliCookie(cookieHeader: string) {
    const outcome = await this.probeBilibiliNavCookie(cookieHeader);
    if (outcome.kind === 'ok') return { mid: outcome.mid, uname: outcome.uname };
    if (outcome.kind === 'invalid') throw new BadRequestException(outcome.message);
    if (outcome.kind === 'timeout' || outcome.kind === 'network') {
      throw new BadGatewayException('暂时无法连接 B 站核验接口，请检查网络后重试');
    }
    if (outcome.kind === 'rate_limited') {
      throw new BadGatewayException(`B 站核验接口触发限流（HTTP ${outcome.httpStatus}），请稍后重试`);
    }
    if (outcome.kind === 'upstream_http') {
      throw new BadGatewayException(`B 站核验接口返回 HTTP ${outcome.httpStatus}`);
    }
    throw new BadGatewayException('B 站核验接口返回格式异常，请稍后重试');
  }

  private async uniqueDisplayName(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    platform: 'bilibili' | 'xiaohongshu',
    preferred: string,
  ) {
    // 数据库的「工作室 + 平台 + 显示名」唯一索引包含已归档账号，这里也必须一起避开，
    // 否则同名账号重新接入时会撞唯一键，接口直接 500。
    const existing = await tx.channelAccount.findMany({
      where: { workspaceId, platform },
      select: { displayName: true },
    });
    const used = new Set(existing.map(({ displayName }) => displayName));
    const base = Array.from(preferred.trim() || '新账号').slice(0, 50).join('');
    let candidate = base;
    for (let suffix = 2; used.has(candidate); suffix++) {
      candidate = `${base} (${suffix})`;
    }
    return candidate;
  }

  private decryptTicketSecret(scope: string, workspaceId: string, userId: string, ticketId: string, ciphertext: string | null, keyId: string | null) {
    if (!ciphertext || keyId !== platformKeyId) return null;
    try {
      return decryptPlatformSecret([scope, workspaceId, userId, ticketId], ciphertext);
    } catch {
      return null;
    }
  }

  async startBilibiliWebQr(workspaceId: string, userId: string, groupId?: string | null) {
    const key = JSON.stringify([workspaceId, userId]);
    if (this.startingBiliQr.has(key)) {
      throw new ConflictException('正在生成二维码，请稍后重试');
    }
    this.startingBiliQr.add(key);
    try {
      const validGroupId = await this.groups.assertWorkspaceGroup(this.prisma, workspaceId, groupId);
      const now = new Date();
      await this.cleanupQrTickets(workspaceId, userId, now);

      const startedAt = Date.now();
      let response: Response;
      try {
        response = await fetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
          headers: biliWebHeaders,
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        if (isTimeoutError(error)) {
          this.logger.warn(`[QR] upstream_timeout ticketId=pending stage=generate durationMs=${durationMs}`);
          throw new BadGatewayException('连接 B 站二维码生成接口超时，请稍后重试');
        }
        this.logger.warn(`[QR] network_error ticketId=pending stage=generate errorType=${errorName(error)} durationMs=${durationMs}`);
        throw new BadGatewayException('暂时无法连接 B 站扫码登录服务，请检查网络后重试');
      }

      const durationMs = Date.now() - startedAt;
      if (response.status === 429 || response.status === 412) {
        this.logger.warn(`[QR] upstream_invalid_response ticketId=pending stage=generate httpStatus=${response.status} durationMs=${durationMs}`);
        throw new BadGatewayException(`B 站二维码服务请求受限（HTTP ${response.status}），请稍后重试`);
      }
      if (!response.ok) {
        this.logger.warn(`[QR] upstream_invalid_response ticketId=pending stage=generate httpStatus=${response.status} durationMs=${durationMs}`);
        throw new BadGatewayException(`B 站二维码服务返回 HTTP ${response.status}`);
      }

      const rawJson = await response.json().catch(() => null);
      const payload = qrGenerateResponseSchema.safeParse(rawJson);
      if (!payload.success) {
        this.logger.warn(`[QR] upstream_invalid_response ticketId=pending stage=generate httpStatus=${response.status} durationMs=${durationMs}`);
        throw new BadGatewayException('B 站二维码返回格式异常，请稍后重试');
      }

      const qrUrl = new URL(payload.data.data.url);
      const urlKey = qrUrl.searchParams.get('qrcode_key');
      if (urlKey && urlKey !== payload.data.data.qrcode_key) {
        this.logger.warn(`[QR] upstream_invalid_response ticketId=pending stage=generate reason=qrcode_key_mismatch durationMs=${durationMs}`);
        throw new BadGatewayException('B 站返回的二维码参数不一致，请重试生成');
      }

      const ticketId = randomUUID();
      const createdAtMs = Date.now();
      const expiresAt = new Date(createdAtMs + BILI_QR_TTL_MS);
      const nextPollAt = new Date(createdAtMs + BILI_POLL_INTERVAL_MS);
      const qrcodeKeyCiphertext = encryptPlatformSecret(
        ['bili-qr', workspaceId, userId, ticketId],
        payload.data.data.qrcode_key,
      );

      // Supersede previous active tickets for the same operator in this workspace.
      await this.prisma.bilibiliQrTicket.updateMany({
        where: {
          workspaceId,
          userId,
          state: { in: ['WAITING_SCAN', 'SCANNED', 'VERIFYING', 'VERIFY_FAILED', 'SAVE_FAILED'] },
        },
        data: {
          state: 'CANCELED',
          lastError: '用户已重新生成二维码',
          qrcodeKeyCiphertext: null,
          qrcodeKeyKeyId: null,
          tempCookieCiphertext: null,
          tempCookieKeyId: null,
          tempMid: null,
          tempUname: null,
          lockedUntil: null,
        },
      });

      await this.prisma.bilibiliQrTicket.create({
        data: {
          id: ticketId,
          workspaceId,
          userId,
          groupId: validGroupId,
          verificationUrl: payload.data.data.url,
          qrcodeKeyCiphertext,
          qrcodeKeyKeyId: platformKeyId,
          state: 'WAITING_SCAN',
          expiresAt,
          nextPollAt,
        },
      });

      this.logger.log(`[QR] ticket_created ticketId=${ticketId} httpStatus=${response.status} durationMs=${durationMs}`);
      return {
        id: ticketId,
        verificationUrl: payload.data.data.url,
        expiresAt: expiresAt.getTime(),
        state: 'WAITING_SCAN' as const,
        businessState: 'WAITING_SCAN' as const,
        status: 'pending' as const,
        code: null,
        message: QR_STATE_MESSAGES.WAITING_SCAN,
      };
    } finally {
      this.startingBiliQr.delete(key);
    }
  }

  async getActiveBilibiliWebQr(workspaceId: string, userId: string) {
    const now = new Date();
    const ticket = await this.prisma.bilibiliQrTicket.findFirst({
      where: {
        workspaceId,
        userId,
        expiresAt: { gt: now },
        state: { in: ['WAITING_SCAN', 'SCANNED', 'VERIFYING', 'VERIFY_FAILED', 'SAVE_FAILED'] },
      },
      orderBy: [{ createdAt: 'desc' }],
    });
    if (!ticket) return null;
    const businessState = ticket.state as QrBusinessState;
    return {
      ...this.buildQrResult({
        id: ticket.id,
        state: businessState,
        businessState,
        code: ticket.lastBiliCode,
        expiresAt: ticket.expiresAt.getTime(),
        message: ticket.lastError || QR_STATE_MESSAGES[businessState],
        accountId: ticket.accountId,
        canRetry: businessState === 'VERIFY_FAILED' || businessState === 'SAVE_FAILED',
      }),
      verificationUrl: ticket.verificationUrl,
    };
  }

  async cancelBilibiliWebQr(workspaceId: string, userId: string, id: string): Promise<QrPollResult> {
    const ticket = await this.prisma.bilibiliQrTicket.findFirst({
      where: { id, workspaceId, userId },
    });
    if (!ticket) throw new NotFoundException('扫码请求不存在或已清理');
    const businessState = ticket.state as QrBusinessState;
    if (businessState === 'CONNECTED' || businessState === 'QR_EXPIRED' || businessState === 'CANCELED') {
      return this.buildQrResult({
        id: ticket.id,
        state: businessState,
        businessState,
        code: ticket.lastBiliCode,
        expiresAt: ticket.expiresAt.getTime(),
        message: ticket.lastError || QR_STATE_MESSAGES[businessState],
        accountId: ticket.accountId,
      });
    }
    assertQrTransition(businessState, 'CANCELED');
    await this.prisma.bilibiliQrTicket.update({
      where: { id: ticket.id },
      data: {
        state: 'CANCELED',
        lastError: QR_STATE_MESSAGES.CANCELED,
        qrcodeKeyCiphertext: null,
        qrcodeKeyKeyId: null,
        tempCookieCiphertext: null,
        tempCookieKeyId: null,
        tempMid: null,
        tempUname: null,
        lockedUntil: null,
      },
    });
    this.logger.log(`[QR] ticket_canceled ticketId=${id}`);
    return this.buildQrResult({
      id: ticket.id,
      state: 'CANCELED',
      businessState: 'CANCELED',
      code: ticket.lastBiliCode,
      expiresAt: ticket.expiresAt.getTime(),
    });
  }

  private async verifyAndSaveTicket(params: {
    workspaceId: string;
    userId: string;
    ticketId: string;
    groupId: string | null;
    expiresAtMs: number;
    cookieHeader: string;
    existingMid?: string | null;
    existingUname?: string | null;
    currentState: QrBusinessState;
  }): Promise<QrPollResult> {
    const { workspaceId, userId, ticketId, groupId, expiresAtMs, cookieHeader } = params;
    let mid = params.existingMid ?? null;
    let uname = params.existingUname ?? null;

    if (!mid || !uname) {
      const verifyStart = Date.now();
      const probe = await this.probeBilibiliNavCookie(cookieHeader);
      const verifyDuration = Date.now() - verifyStart;

      if (probe.kind === 'timeout') {
        this.logger.warn(`[QR] upstream_timeout ticketId=${ticketId} stage=cookie_verify durationMs=${verifyDuration}`);
        return this.buildQrResult({
          id: ticketId,
          state: 'NETWORK_ERROR',
          businessState: 'VERIFYING',
          code: 0,
          expiresAt: expiresAtMs,
          retryAfterMs: 3000,
          canRetry: true,
          message: 'B 站已确认扫码，但连接用户信息核验接口超时，正在重试核验…',
        });
      }
      if (probe.kind === 'network' || probe.kind === 'upstream_http' || probe.kind === 'invalid_json') {
        this.logger.warn(
          `[QR] network_error ticketId=${ticketId} stage=cookie_verify kind=${probe.kind} durationMs=${verifyDuration}`,
        );
        return this.buildQrResult({
          id: ticketId,
          state: 'NETWORK_ERROR',
          businessState: 'VERIFYING',
          code: 0,
          expiresAt: expiresAtMs,
          retryAfterMs: 3000,
          canRetry: true,
          message: 'B 站已确认扫码，但核验接口网络暂不可用，正在重试…',
        });
      }
      if (probe.kind === 'rate_limited') {
        this.logger.warn(`[QR] upstream_invalid_response ticketId=${ticketId} stage=cookie_verify httpStatus=${probe.httpStatus}`);
        return this.buildQrResult({
          id: ticketId,
          state: 'RATE_LIMITED',
          businessState: 'VERIFYING',
          code: 0,
          expiresAt: expiresAtMs,
          retryAfterMs: 5000,
          canRetry: true,
          message: 'B 站核验接口限流，稍后将自动继续核验。',
        });
      }
      if (probe.kind === 'invalid') {
        this.logger.warn(
          `[QR] cookie_verify_failed ticketId=${ticketId} stage=cookie_verify biliCode=${probe.biliCode ?? 'unknown'} durationMs=${verifyDuration}`,
        );
        if (canQrTransition(params.currentState, 'VERIFY_FAILED')) {
          await this.prisma.bilibiliQrTicket.update({
            where: { id: ticketId },
            data: {
              state: 'VERIFY_FAILED',
              lastError: probe.message,
              tempCookieCiphertext: null,
              tempCookieKeyId: null,
              tempMid: null,
              tempUname: null,
            },
          });
        }
        return this.buildQrResult({
          id: ticketId,
          state: 'VERIFY_FAILED',
          businessState: 'VERIFY_FAILED',
          code: 0,
          expiresAt: expiresAtMs,
          canRetry: false,
          message: probe.message,
        });
      }

      mid = probe.mid;
      uname = probe.uname;
      this.logger.log(`[QR] cookie_verify_success ticketId=${ticketId} durationMs=${verifyDuration}`);
      await this.prisma.bilibiliQrTicket.update({
        where: { id: ticketId },
        data: { tempMid: mid, tempUname: uname },
      });
    }

    const saveStart = Date.now();
    try {
      const accountId = await this.saveBilibiliWebAccount(workspaceId, userId, {
        mid,
        uname,
        cookieHeader,
        accessMethod: 'qr_login',
        groupId,
      });
      const saveDuration = Date.now() - saveStart;
      this.logger.log(`[QR] account_save_success ticketId=${ticketId} accountId=${accountId} durationMs=${saveDuration}`);

      await this.prisma.bilibiliQrTicket.update({
        where: { id: ticketId },
        data: {
          state: 'CONNECTED',
          accountId,
          lastError: null,
          qrcodeKeyCiphertext: null,
          qrcodeKeyKeyId: null,
          tempCookieCiphertext: null,
          tempCookieKeyId: null,
          tempMid: null,
          tempUname: null,
        },
      });
      this.logger.log(`[QR] connected ticketId=${ticketId} accountId=${accountId}`);
      return this.buildQrResult({
        id: ticketId,
        state: 'CONNECTED',
        businessState: 'CONNECTED',
        code: 0,
        expiresAt: expiresAtMs,
        accountId,
      });
    } catch (error) {
      const saveDuration = Date.now() - saveStart;
      const reason = error instanceof Error ? error.message : '数据库写入失败';
      this.logger.error(
        `[QR] account_save_failed ticketId=${ticketId} stage=account_save errorType=${errorName(error)} durationMs=${saveDuration}`,
      );
      await this.prisma.bilibiliQrTicket.update({
        where: { id: ticketId },
        data: {
          state: 'SAVE_FAILED',
          lastError: reason,
        },
      });
      return this.buildQrResult({
        id: ticketId,
        state: 'SAVE_FAILED',
        businessState: 'SAVE_FAILED',
        code: 0,
        expiresAt: expiresAtMs,
        canRetry: true,
        message: `账号核验已通过，但保存失败：${reason}`,
      });
    }
  }

  async pollBilibiliWebQr(workspaceId: string, userId: string, id: string, manual = false): Promise<QrPollResult> {
    const ticket = await this.prisma.bilibiliQrTicket.findFirst({
      where: { id, workspaceId, userId },
    });
    if (!ticket) {
      this.logger.warn(`[QR] upstream_invalid_response ticketId=${id} stage=lookup reason=not_found`);
      throw new NotFoundException('扫码会话不存在或已过期，请重新获取二维码');
    }

    const businessState = ticket.state as QrBusinessState;
    const expiresAtMs = ticket.expiresAt.getTime();
    const now = new Date();
    const nowMs = now.getTime();

    if (businessState === 'CONNECTED' || businessState === 'QR_EXPIRED' || businessState === 'CANCELED') {
      return this.buildQrResult({
        id: ticket.id,
        state: businessState,
        businessState,
        code: ticket.lastBiliCode,
        expiresAt: expiresAtMs,
        message: ticket.lastError || QR_STATE_MESSAGES[businessState],
        accountId: ticket.accountId,
      });
    }

    const hasCachedCookie = Boolean(ticket.tempCookieCiphertext);
    if (!hasCachedCookie && expiresAtMs <= nowMs) {
      assertQrTransition(businessState, 'QR_EXPIRED');
      await this.prisma.bilibiliQrTicket.update({
        where: { id: ticket.id },
        data: {
          state: 'QR_EXPIRED',
          lastError: QR_STATE_MESSAGES.QR_EXPIRED,
          qrcodeKeyCiphertext: null,
          qrcodeKeyKeyId: null,
          lockedUntil: null,
        },
      });
      this.logger.log(`[QR] qr_expired ticketId=${id} reason=local_ttl`);
      return this.buildQrResult({
        id: ticket.id,
        state: 'QR_EXPIRED',
        businessState: 'QR_EXPIRED',
        code: 86038,
        expiresAt: expiresAtMs,
      });
    }

    if (!manual && !hasCachedCookie && ticket.nextPollAt.getTime() > nowMs) {
      return this.buildQrResult({
        id: ticket.id,
        state: businessState,
        businessState,
        code: ticket.lastBiliCode,
        expiresAt: expiresAtMs,
        message: ticket.lastError || QR_STATE_MESSAGES[businessState],
      });
    }

    // Atomic concurrency lock across concurrent polls / API restarts.
    const lockUntil = new Date(nowMs + BILI_POLL_LOCK_MS);
    const { count: locked } = await this.prisma.bilibiliQrTicket.updateMany({
      where: {
        id: ticket.id,
        workspaceId,
        userId,
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
      },
      data: { lockedUntil: lockUntil },
    });
    if (!locked) {
      return this.buildQrResult({
        id: ticket.id,
        state: businessState,
        businessState,
        code: ticket.lastBiliCode,
        expiresAt: expiresAtMs,
        message: ticket.lastError || QR_STATE_MESSAGES[businessState],
      });
    }

    this.logger.log(`[QR] poll_started ticketId=${id} state=${businessState}`);
    try {
      // Resume verification/save directly if Bilibili already returned code=0 on an earlier poll.
      if (hasCachedCookie) {
        const cachedCookie = this.decryptTicketSecret(
          'bili-qr-cookie',
          workspaceId,
          userId,
          ticket.id,
          ticket.tempCookieCiphertext,
          ticket.tempCookieKeyId,
        );
        if (!cachedCookie) {
          await this.prisma.bilibiliQrTicket.update({
            where: { id: ticket.id },
            data: {
              state: 'VERIFY_FAILED',
              lastError: '临时登录凭据已失效，请重新扫码',
              tempCookieCiphertext: null,
              tempCookieKeyId: null,
              tempMid: null,
              tempUname: null,
            },
          });
          return this.buildQrResult({
            id: ticket.id,
            state: 'VERIFY_FAILED',
            businessState: 'VERIFY_FAILED',
            code: 0,
            expiresAt: expiresAtMs,
            canRetry: false,
            message: '临时登录凭据已失效，请重新生成二维码扫码',
          });
        }
        return await this.verifyAndSaveTicket({
          workspaceId,
          userId,
          ticketId: ticket.id,
          groupId: ticket.groupId,
          expiresAtMs,
          cookieHeader: cachedCookie,
          existingMid: ticket.tempMid,
          existingUname: ticket.tempUname,
          currentState: businessState,
        });
      }

      const qrcodeKey = this.decryptTicketSecret(
        'bili-qr',
        workspaceId,
        userId,
        ticket.id,
        ticket.qrcodeKeyCiphertext,
        ticket.qrcodeKeyKeyId,
      );
      if (!qrcodeKey) {
        this.logger.warn(`[QR] upstream_invalid_response ticketId=${id} stage=poll reason=missing_qrcode_key`);
        await this.prisma.bilibiliQrTicket.update({
          where: { id: ticket.id },
          data: { state: 'VERIFY_FAILED', lastError: '扫码票据密钥已失效，请重新生成二维码' },
        });
        return this.buildQrResult({
          id: ticket.id,
          state: 'VERIFY_FAILED',
          businessState: 'VERIFY_FAILED',
          code: null,
          expiresAt: expiresAtMs,
          canRetry: false,
          message: '扫码票据状态不可恢复，请重新生成二维码',
        });
      }

      const url = new URL('https://passport.bilibili.com/x/passport-login/web/qrcode/poll');
      url.searchParams.set('qrcode_key', qrcodeKey);

      const upstreamStart = Date.now();
      let response: Response;
      try {
        response = await fetch(url, {
          headers: biliWebHeaders,
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        const durationMs = Date.now() - upstreamStart;
        if (isTimeoutError(error)) {
          this.logger.warn(`[QR] upstream_timeout ticketId=${id} stage=poll durationMs=${durationMs}`);
          return this.buildQrResult({
            id: ticket.id,
            state: 'NETWORK_ERROR',
            businessState,
            code: ticket.lastBiliCode,
            expiresAt: expiresAtMs,
            retryAfterMs: 3000,
            canRetry: true,
            message: '查询 B 站扫码状态超时，二维码仍有效，正在重试…',
          });
        }
        this.logger.warn(`[QR] network_error ticketId=${id} stage=poll errorType=${errorName(error)} durationMs=${durationMs}`);
        return this.buildQrResult({
          id: ticket.id,
          state: 'NETWORK_ERROR',
          businessState,
          code: ticket.lastBiliCode,
          expiresAt: expiresAtMs,
          retryAfterMs: 3000,
          canRetry: true,
          message: QR_STATE_MESSAGES.NETWORK_ERROR,
        });
      }

      const durationMs = Date.now() - upstreamStart;
      if (response.status === 429 || response.status === 412) {
        this.logger.warn(`[QR] upstream_invalid_response ticketId=${id} stage=poll httpStatus=${response.status} durationMs=${durationMs}`);
        return this.buildQrResult({
          id: ticket.id,
          state: 'RATE_LIMITED',
          businessState,
          code: ticket.lastBiliCode,
          expiresAt: expiresAtMs,
          retryAfterMs: 5000,
          canRetry: true,
          message: `B 站查询受限（HTTP ${response.status}），将自动放慢重试频率`,
        });
      }
      if (!response.ok) {
        this.logger.warn(`[QR] upstream_invalid_response ticketId=${id} stage=poll httpStatus=${response.status} durationMs=${durationMs}`);
        return this.buildQrResult({
          id: ticket.id,
          state: 'NETWORK_ERROR',
          businessState,
          code: ticket.lastBiliCode,
          expiresAt: expiresAtMs,
          retryAfterMs: 3500,
          canRetry: true,
          message: `B 站扫码状态接口返回 HTTP ${response.status}，二维码仍有效，将重试查询`,
        });
      }

      const rawJson = await response.json().catch(() => null);
      const payload = qrPollResponseSchema.safeParse(rawJson);
      if (!payload.success) {
        this.logger.warn(`[QR] upstream_invalid_response ticketId=${id} stage=poll httpStatus=${response.status} durationMs=${durationMs} reason=invalid_json`);
        return this.buildQrResult({
          id: ticket.id,
          state: 'NETWORK_ERROR',
          businessState,
          code: ticket.lastBiliCode,
          expiresAt: expiresAtMs,
          retryAfterMs: 3500,
          canRetry: true,
          message: 'B 站扫码接口返回非预期数据，二维码仍有效，将重试查询',
        });
      }

      const code = payload.data.data.code;
      this.logger.log(`[QR] poll_response ticketId=${id} code=${code} httpStatus=${response.status} durationMs=${durationMs}`);

      if (code === 86101) {
        assertQrTransition(businessState, 'WAITING_SCAN');
        await this.prisma.bilibiliQrTicket.update({
          where: { id: ticket.id },
          data: { state: 'WAITING_SCAN', lastBiliCode: 86101, lastError: null },
        });
        return this.buildQrResult({
          id: ticket.id,
          state: 'WAITING_SCAN',
          businessState: 'WAITING_SCAN',
          code: 86101,
          expiresAt: expiresAtMs,
        });
      }

      if (code === 86090) {
        assertQrTransition(businessState, 'SCANNED');
        await this.prisma.bilibiliQrTicket.update({
          where: { id: ticket.id },
          data: { state: 'SCANNED', lastBiliCode: 86090, lastError: null },
        });
        return this.buildQrResult({
          id: ticket.id,
          state: 'SCANNED',
          businessState: 'SCANNED',
          code: 86090,
          expiresAt: expiresAtMs,
        });
      }

      if (code === 86038) {
        assertQrTransition(businessState, 'QR_EXPIRED');
        await this.prisma.bilibiliQrTicket.update({
          where: { id: ticket.id },
          data: {
            state: 'QR_EXPIRED',
            lastBiliCode: 86038,
            lastError: QR_STATE_MESSAGES.QR_EXPIRED,
            qrcodeKeyCiphertext: null,
            qrcodeKeyKeyId: null,
          },
        });
        this.logger.log(`[QR] qr_expired ticketId=${id} code=86038`);
        return this.buildQrResult({
          id: ticket.id,
          state: 'QR_EXPIRED',
          businessState: 'QR_EXPIRED',
          code: 86038,
          expiresAt: expiresAtMs,
        });
      }

      if (code === -412 || code === -509 || code === -799) {
        return this.buildQrResult({
          id: ticket.id,
          state: 'RATE_LIMITED',
          businessState,
          code,
          expiresAt: expiresAtMs,
          retryAfterMs: 5000,
          canRetry: true,
          message: payload.data.data.message || `B 站扫码查询受限（${code}），稍后自动重试`,
        });
      }

      if (code !== 0) {
        const msg = payload.data.data.message || `B 站返回异常状态码（${code}）`;
        this.logger.warn(`[QR] upstream_invalid_response ticketId=${id} code=${code}`);
        return this.buildQrResult({
          id: ticket.id,
          state: 'NETWORK_ERROR',
          businessState,
          code,
          expiresAt: expiresAtMs,
          retryAfterMs: 3500,
          canRetry: true,
          message: msg,
        });
      }

      // code === 0: Login confirmed by Bilibili app!
      const extracted = extractCookiesFromResponse(response, payload.data.data.url);
      if (!extracted.cookieHeader || !extracted.hasSessdata) {
        this.logger.warn(`[QR] cookie_extract_failed ticketId=${id} stage=cookie_extract hasSessdata=${extracted.hasSessdata}`);
        assertQrTransition(businessState, 'VERIFYING');
        await this.prisma.bilibiliQrTicket.update({
          where: { id: ticket.id },
          data: {
            state: 'VERIFY_FAILED',
            lastBiliCode: 0,
            lastError: 'B 站已确认扫码，但未提取到有效登录 Cookie（缺少 SESSDATA），请重新扫码或改用 Cookie 导入',
            qrcodeKeyCiphertext: null,
            qrcodeKeyKeyId: null,
          },
        });
        return this.buildQrResult({
          id: ticket.id,
          state: 'VERIFY_FAILED',
          businessState: 'VERIFY_FAILED',
          code: 0,
          expiresAt: expiresAtMs,
          canRetry: false,
          message: 'B 站已确认扫码，但未提取到有效登录 Cookie（缺少 SESSDATA），请重新生成二维码或改用 Cookie 导入',
        });
      }

      this.logger.log(
        `[QR] cookie_extract_success ticketId=${id} hasSessdata=${extracted.hasSessdata} hasBiliJct=${extracted.hasBiliJct} hasDedeUserId=${extracted.hasDedeUserId}`,
      );
      assertQrTransition(businessState, 'VERIFYING');
      const tempCookieCiphertext = encryptPlatformSecret(
        ['bili-qr-cookie', workspaceId, userId, ticket.id],
        extracted.cookieHeader,
      );
      await this.prisma.bilibiliQrTicket.update({
        where: { id: ticket.id },
        data: {
          state: 'VERIFYING',
          lastBiliCode: 0,
          lastError: null,
          qrcodeKeyCiphertext: null,
          qrcodeKeyKeyId: null,
          tempCookieCiphertext,
          tempCookieKeyId: platformKeyId,
        },
      });

      return await this.verifyAndSaveTicket({
        workspaceId,
        userId,
        ticketId: ticket.id,
        groupId: ticket.groupId,
        expiresAtMs,
        cookieHeader: extracted.cookieHeader,
        currentState: 'VERIFYING',
      });
    } finally {
      await this.prisma.bilibiliQrTicket.updateMany({
        where: { id: ticket.id, workspaceId, userId },
        data: {
          lockedUntil: null,
          nextPollAt: new Date(Date.now() + BILI_POLL_INTERVAL_MS),
        },
      }).catch(() => {});
    }
  }

  private async saveBilibiliWebAccount(
    workspaceId: string,
    userId: string,
    params: {
      mid: string;
      uname: string;
      cookieHeader: string;
      accessMethod: 'qr_login' | 'cookie';
      accountId?: string;
      displayName?: string;
      operator?: string;
      groupId?: string | null;
      alias?: string;
      tags?: string[];
      cookieExpiresAt?: Date | null;
      egressIp?: string | null;
      profileLabel?: string | null;
    },
  ) {
    const webId = bilibiliWebUidPrefix + params.mid;
    const manualId = bilibiliManualUidPrefix + params.mid;
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
      const validGroupId = params.groupId !== undefined
        ? await this.groups.assertWorkspaceGroup(tx, workspaceId, params.groupId)
        : undefined;
      const existing = params.accountId
        ? await tx.channelAccount.findFirst({ where: { id: params.accountId, workspaceId, platform: 'bilibili' } })
        : await tx.channelAccount.findFirst({
            where: { workspaceId, platform: 'bilibili', externalId: { in: [webId, manualId] } },
          });
      if (existing?.archivedAt) {
        throw new ConflictException('该 B 站账号已归档，请先在归档列表中恢复后再更新登录态');
      }
      if (existing && existing.channelKind === 'official') {
        throw new ConflictException('该 B 站账号已绑定开放平台官方通道');
      }

      const id = existing?.id ?? randomUUID();
      const { ciphertext, keyId } = encryptAccountSecret('cookie', workspaceId, id, params.cookieHeader);
      const resolvedName = existing
        ? existing.displayName
        : await this.uniqueDisplayName(tx, workspaceId, 'bilibili', params.displayName?.trim() || params.uname);

      const commonData = {
        externalId: webId,
        channelKind: 'manual' as const,
        accessMethod: params.accessMethod,
        authStatus: 'active' as const,
        authCheckedAt: now,
        authAuthorizedBy: userId,
        cookieCiphertext: ciphertext,
        cookieKeyId: keyId,
        cookieUpdatedAt: now,
        ...(params.cookieExpiresAt !== undefined && { cookieExpiresAt: params.cookieExpiresAt }),
        ...(params.egressIp !== undefined && { egressIp: params.egressIp }),
        ...(params.profileLabel !== undefined && { profileLabel: params.profileLabel }),
        riskStatus: 'normal' as const,
        riskReason: null,
        riskDetectedAt: null,
        ...(validGroupId !== undefined && { groupId: validGroupId }),
        ...(params.operator !== undefined && { operator: params.operator.trim() || null }),
        ...(params.alias !== undefined && { alias: params.alias.trim() || null }),
        ...(params.tags !== undefined && { tags: cleanTags(params.tags) }),
      };

      if (existing) {
        await tx.channelAccount.update({ where: { id }, data: commonData });
        await tx.accountRiskEvent.updateMany({
          where: { workspaceId, accountId: id, resolvedAt: null },
          data: { resolvedAt: now, resolvedById: userId },
        });
      } else {
        await tx.channelAccount.create({
          data: {
            id,
            workspaceId,
            platform: 'bilibili',
            displayName: resolvedName,
            ...commonData,
          },
        });
      }
      return id;
    });
  }

  async addPasswordAccount(workspaceId: string, userId: string, input: z.infer<typeof passwordAccountSchema>) {
    const parsedProfile = parseProfileInput(input.platform, input.profileUrl ?? input.profile);
    const uid = input.platform === 'bilibili' ? parsedProfile.uid : null;
    const now = new Date();
    const masked = maskLoginIdentifier(input.loginIdentifier);
    const egressIp = input.egressIp !== undefined ? normalizeEgressIp(input.egressIp) : undefined;
    const profileLabel = input.profileLabel !== undefined ? (input.profileLabel?.trim() || null) : undefined;
    const id = randomUUID();
    const { ciphertext, keyId } = encryptAccountSecret(
      'password',
      workspaceId,
      id,
      JSON.stringify({ loginIdentifier: input.loginIdentifier, password: input.password }),
    );

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
        const groupId = await this.groups.assertWorkspaceGroup(tx, workspaceId, input.groupId);
        if (uid) {
          const dupUid = await tx.channelAccount.findFirst({
            where: {
              workspaceId,
              platform: 'bilibili',
              externalId: { in: [bilibiliManualUidPrefix + uid, bilibiliWebUidPrefix + uid] },
            },
            select: { archivedAt: true },
          });
          if (dupUid) {
            throw new ConflictException(dupUid.archivedAt ? '这个 B 站 UID 已归档，请在归档列表恢复' : '这个 B 站 UID 已经添加');
          }
        }
        const created = await tx.channelAccount.create({
          data: {
            id,
            workspaceId,
            platform: input.platform,
            channelKind: 'manual',
            accessMethod: 'password',
            displayName: input.displayName,
            externalId: uid ? bilibiliWebUidPrefix + uid : `pwd-${id}`,
            operator: input.operator?.trim() || null,
            groupId,
            alias: input.alias?.trim() || null,
            tags: cleanTags(input.tags),
            ...(egressIp !== undefined && { egressIp }),
            ...(profileLabel !== undefined && { profileLabel }),
            ...(parsedProfile.profileUrl !== undefined && { profileUrl: parsedProfile.profileUrl }),
            loginIdentifier: masked,
            passwordCiphertext: ciphertext,
            passwordKeyId: keyId,
            authStatus: 'active',
            authCheckedAt: now,
            authAuthorizedBy: userId,
          },
          select: { id: true, displayName: true, platform: true },
        });
        return created;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('该平台下已有同名在用账号，请更换账号显示名称');
      }
      throw error;
    }
  }

  async importCookieAccount(workspaceId: string, userId: string, input: z.infer<typeof cookieImportSchema>) {
    const { entries, header, expiresAt } = parseCookieHeader(input.cookie);
    validatePlatformCookie(input.platform, entries);
    const cookieExpiresAt = input.cookieExpiresAt !== undefined ? input.cookieExpiresAt : expiresAt;
    const egressIp = input.egressIp !== undefined ? normalizeEgressIp(input.egressIp) : undefined;
    const profileLabel = input.profileLabel !== undefined ? (input.profileLabel?.trim() || null) : undefined;

    if (input.platform === 'bilibili') {
      const { mid, uname } = await this.verifyBilibiliCookie(header);
      const id = await this.saveBilibiliWebAccount(workspaceId, userId, {
        mid,
        uname,
        cookieHeader: header,
        accessMethod: 'cookie',
        accountId: input.accountId,
        displayName: input.displayName,
        operator: input.operator,
        groupId: input.groupId,
        alias: input.alias,
        tags: input.tags,
        cookieExpiresAt,
        egressIp,
        profileLabel,
      });
      return { id, platform: 'bilibili' as const };
    }

    const explicitProfileUrl = parseProfileInput('xiaohongshu', input.profileUrl).profileUrl;
    const creatorUserId = entries['x-user-id-creator.xiaohongshu.com']?.trim();
    const detectedProfileUrl = explicitProfileUrl === undefined && creatorUserId && /^[0-9a-f]{24}$/i.test(creatorUserId)
      ? `https://www.xiaohongshu.com/user/profile/${creatorUserId}`
      : undefined;

    const identitySeed = entries['x-user-id-creator.xiaohongshu.com']
      || entries['customer-sso-sid']
      || entries.a1
      || entries.web_session
      || header;
    const identityHash = createHash('sha256').update(identitySeed).digest('hex').slice(0, 24);
    const externalId = `xhs-cookie:${identityHash}`;
    const now = new Date();

    const accountId = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
      const validGroupId = input.groupId !== undefined
        ? await this.groups.assertWorkspaceGroup(tx, workspaceId, input.groupId)
        : undefined;
      const existing = input.accountId
        ? await tx.channelAccount.findFirst({ where: { id: input.accountId, workspaceId, platform: 'xiaohongshu' } })
        : await tx.channelAccount.findFirst({ where: { workspaceId, platform: 'xiaohongshu', externalId } });

      if (existing?.archivedAt) {
        throw new ConflictException('该小红书账号已归档，请在归档列表恢复后再更新 Cookie');
      }
      if (!existing && !input.displayName?.trim()) {
        throw new BadRequestException('首次导入小红书 Cookie 请填写账号显示名称');
      }

      const id = existing?.id ?? randomUUID();
      const { ciphertext, keyId } = encryptAccountSecret('cookie', workspaceId, id, header);
      const nextProfileUrl = explicitProfileUrl !== undefined
        ? explicitProfileUrl
        : !existing?.profileUrl
          ? detectedProfileUrl
          : undefined;
      const commonData = {
        channelKind: 'manual' as const,
        accessMethod: 'cookie' as const,
        authStatus: 'active' as const,
        authCheckedAt: now,
        authAuthorizedBy: userId,
        cookieCiphertext: ciphertext,
        cookieKeyId: keyId,
        cookieUpdatedAt: now,
        ...(cookieExpiresAt !== undefined && { cookieExpiresAt }),
        ...(egressIp !== undefined && { egressIp }),
        ...(profileLabel !== undefined && { profileLabel }),
        ...(nextProfileUrl !== undefined && { profileUrl: nextProfileUrl }),
        riskStatus: 'normal' as const,
        riskReason: null,
        riskDetectedAt: null,
        ...(validGroupId !== undefined && { groupId: validGroupId }),
        ...(input.operator !== undefined && { operator: input.operator.trim() || null }),
        ...(input.alias !== undefined && { alias: input.alias.trim() || null }),
        ...(input.tags !== undefined && { tags: cleanTags(input.tags) }),
      };

      if (existing) {
        await tx.channelAccount.update({ where: { id }, data: commonData });
        await tx.accountRiskEvent.updateMany({
          where: { workspaceId, accountId: id, resolvedAt: null },
          data: { resolvedAt: now, resolvedById: userId },
        });
      } else {
        const displayName = await this.uniqueDisplayName(tx, workspaceId, 'xiaohongshu', input.displayName!.trim());
        await tx.channelAccount.create({
          data: {
            id,
            workspaceId,
            platform: 'xiaohongshu',
            displayName,
            externalId,
            ...commonData,
          },
        });
      }
      return id;
    });
    return { id: accountId, platform: 'xiaohongshu' as const };
  }

  async configureReadSession(workspaceId: string, accountId: string, input: z.infer<typeof readSessionSchema>) {
    const now = new Date();
    const parsedCookie = input.readCookie ? parseCookieHeader(input.readCookie) : null;
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
      const account = await tx.channelAccount.findFirst({ where: { id: accountId, workspaceId } });
      if (!account || account.archivedAt) throw new NotFoundException('账号不存在或已归档');

      let nextReadAccountId = account.readAccountId;
      if (input.readAccountId !== undefined) {
        if (input.readAccountId === null) {
          nextReadAccountId = null;
        } else {
          if (input.readAccountId === accountId) {
            throw new BadRequestException('读取小号不能绑定账号本身，请选择同平台其他辅助采集号或直接配置独立读取 Cookie');
          }
          const readAcc = await tx.channelAccount.findFirst({
            where: { id: input.readAccountId, workspaceId, archivedAt: null },
            select: { id: true, platform: true },
          });
          if (!readAcc) throw new NotFoundException('指定的采集小号不存在或已归档');
          if (readAcc.platform !== account.platform) {
            throw new BadRequestException('读写分离账号必须属于同一平台');
          }
          nextReadAccountId = readAcc.id;
        }
      }

      let readCookieUpdate: Record<string, unknown> = {};
      if (input.readCookie === null) {
        readCookieUpdate = {
          readCookieCiphertext: null,
          readCookieKeyId: null,
          readCookieLabel: null,
          readCookieUpdatedAt: null,
        };
      } else if (parsedCookie) {
        validatePlatformCookie(account.platform, parsedCookie.entries);
        const { ciphertext, keyId } = encryptAccountSecret('read-cookie', workspaceId, accountId, parsedCookie.header);
        readCookieUpdate = {
          readCookieCiphertext: ciphertext,
          readCookieKeyId: keyId,
          readCookieLabel: input.readCookieLabel?.trim() || '独立只读会话',
          readCookieUpdatedAt: now,
        };
      } else if (input.readCookieLabel !== undefined) {
        readCookieUpdate = { readCookieLabel: input.readCookieLabel?.trim() || null };
      }

      return tx.channelAccount.update({
        where: { id: accountId },
        data: {
          ...(input.readAccountId !== undefined && { readAccountId: nextReadAccountId }),
          ...readCookieUpdate,
        },
        select: {
          id: true,
          readAccountId: true,
          readAccount: { select: { id: true, displayName: true, alias: true } },
          readCookieLabel: true,
          readCookieUpdatedAt: true,
        },
      });
    });
  }
}
