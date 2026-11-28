/**
 * 统一扫码登录状态机（B 站网页扫码等共用的业务状态与流转校验）。
 *
 * 原则：
 * 1. 仅在 B 站明确返回 86038 或真实过期后才进入 QR_EXPIRED；
 * 2. 网络异常（NETWORK_ERROR）与限流（RATE_LIMITED）属于瞬时传输态，不覆盖持久化业务状态；
 * 3. CONNECTED / QR_EXPIRED / CANCELED 为终态，不可再回退到 WAITING_SCAN。
 */

export const QR_LOGIN_STATES = [
  'WAITING_SCAN',
  'SCANNED',
  'VERIFYING',
  'QR_EXPIRED',
  'VERIFY_FAILED',
  'SAVE_FAILED',
  'NETWORK_ERROR',
  'RATE_LIMITED',
  'CONNECTED',
  'CANCELED',
] as const;

export type QrLoginState = (typeof QR_LOGIN_STATES)[number];

/** 持久化在票据上的核心业务状态（不含瞬时网络/限流状态） */
export type QrBusinessState =
  | 'WAITING_SCAN'
  | 'SCANNED'
  | 'VERIFYING'
  | 'QR_EXPIRED'
  | 'VERIFY_FAILED'
  | 'SAVE_FAILED'
  | 'CONNECTED'
  | 'CANCELED';

export type LegacyQrStatus = 'pending' | 'scanned' | 'expired' | 'denied' | 'connected';

export const QR_TERMINAL_STATES: readonly QrLoginState[] = [
  'QR_EXPIRED',
  'CONNECTED',
  'CANCELED',
];

const QR_TRANSITIONS: Record<QrLoginState, readonly QrLoginState[]> = {
  WAITING_SCAN: ['WAITING_SCAN', 'SCANNED', 'VERIFYING', 'QR_EXPIRED', 'NETWORK_ERROR', 'RATE_LIMITED', 'CANCELED'],
  SCANNED: ['SCANNED', 'VERIFYING', 'QR_EXPIRED', 'NETWORK_ERROR', 'RATE_LIMITED', 'CANCELED'],
  VERIFYING: ['VERIFYING', 'CONNECTED', 'VERIFY_FAILED', 'SAVE_FAILED', 'NETWORK_ERROR', 'RATE_LIMITED', 'QR_EXPIRED', 'CANCELED'],
  VERIFY_FAILED: ['VERIFYING', 'VERIFY_FAILED', 'SAVE_FAILED', 'CONNECTED', 'NETWORK_ERROR', 'RATE_LIMITED', 'QR_EXPIRED', 'CANCELED'],
  SAVE_FAILED: ['VERIFYING', 'SAVE_FAILED', 'CONNECTED', 'VERIFY_FAILED', 'NETWORK_ERROR', 'RATE_LIMITED', 'CANCELED'],
  NETWORK_ERROR: ['WAITING_SCAN', 'SCANNED', 'VERIFYING', 'QR_EXPIRED', 'VERIFY_FAILED', 'SAVE_FAILED', 'CONNECTED', 'NETWORK_ERROR', 'RATE_LIMITED', 'CANCELED'],
  RATE_LIMITED: ['WAITING_SCAN', 'SCANNED', 'VERIFYING', 'QR_EXPIRED', 'VERIFY_FAILED', 'SAVE_FAILED', 'CONNECTED', 'NETWORK_ERROR', 'RATE_LIMITED', 'CANCELED'],
  QR_EXPIRED: [],
  CONNECTED: [],
  CANCELED: [],
};

export function canQrTransition(from: QrLoginState, to: QrLoginState): boolean {
  return QR_TRANSITIONS[from].includes(to);
}

export function assertQrTransition(from: QrLoginState, to: QrLoginState): void {
  if (!canQrTransition(from, to)) {
    throw new Error(`非法扫码状态迁移: ${from} -> ${to}`);
  }
}

export function isTerminalQrState(state: QrLoginState): boolean {
  return QR_TERMINAL_STATES.includes(state);
}

export const QR_STATE_MESSAGES: Record<QrLoginState, string> = {
  WAITING_SCAN: '等待使用手机 B 站 App 扫码…',
  SCANNED: '手机已扫码，请在 B 站 App 点击确认登录。',
  VERIFYING: '已确认登录，正在提取并核验账号信息…',
  QR_EXPIRED: '二维码已过期，请重新生成。',
  VERIFY_FAILED: '登录凭据核验失败，可点击重试或重新生成二维码。',
  SAVE_FAILED: '账号信息核验成功，但保存到工作台失败，请重试保存。',
  NETWORK_ERROR: '网络异常，无法连接 B 站服务，二维码仍有效。',
  RATE_LIMITED: '查询过于频繁或上游限流，稍后将自动重试。',
  CONNECTED: 'B 站账号扫码接入成功。',
  CANCELED: '已取消本次扫码。',
};

export function toLegacyQrStatus(state: QrLoginState, businessState?: QrBusinessState): LegacyQrStatus {
  const effective = (state === 'NETWORK_ERROR' || state === 'RATE_LIMITED') && businessState
    ? businessState
    : state;
  if (effective === 'CONNECTED') return 'connected';
  if (effective === 'QR_EXPIRED' || effective === 'CANCELED') return 'expired';
  if (effective === 'SCANNED' || effective === 'VERIFYING') return 'scanned';
  return 'pending';
}

export type QrPollResult = {
  id: string;
  state: QrLoginState;
  businessState: QrBusinessState;
  status: LegacyQrStatus;
  code: number | null;
  message: string;
  expiresAt: number;
  retryAfterMs?: number;
  accountId?: string;
  canRetry?: boolean;
};
