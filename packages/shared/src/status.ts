/**
 * 发布任务状态机。
 *
 * 底座规则：明确区分「已交接 / 平台审核中 / 已发布 / 失败 / 待核实」，
 * 结果不明时先核对再重试，防止重复发稿。
 * 所有状态迁移必须经过 assertTransition，非法迁移直接拒绝。
 */

export const TASK_STATUSES = [
  'scheduled',
  'dispatching',
  'paused',
  'handed_off',
  'submitted',
  'under_review',
  'published',
  'failed',
  'unknown',
  'verified',
  'canceled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['published', 'canceled'];

/** 已经交给人、或已经提交到平台的状态：此时改稿不能再走「重新排期」了事 */
export const COMMITTED_STATUSES: readonly TaskStatus[] = [
  'handed_off',
  'submitted',
  'under_review',
  'published',
];

/** 改稿时需要自动暂停的状态（尚未提交、尚未交接） */
export const PENDING_STATUSES: readonly TaskStatus[] = ['scheduled', 'paused'];

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  // 等待到点
  scheduled: ['dispatching', 'paused', 'canceled'],
  // 已抢占、正在调用通道
  dispatching: ['handed_off', 'submitted', 'under_review', 'published', 'failed', 'unknown'],
  // 人工暂停
  paused: ['scheduled', 'canceled'],
  // 已生成交接单，等运营发布
  handed_off: ['published', 'failed', 'unknown'],
  // 已提交平台（平台受理）
  submitted: ['under_review', 'published', 'failed', 'unknown'],
  // 平台审核中
  under_review: ['published', 'failed', 'unknown'],
  // 已发布：终态
  published: [],
  // 明确失败：允许重试
  failed: ['scheduled', 'canceled'],
  // 结果不明：必须先核对
  unknown: ['verified'],
  // 核对完成：确认已发 / 确认未发需重试
  verified: ['published', 'failed', 'scheduled'],
  // 已取消：终态
  canceled: [],
};

export class IllegalTransitionError extends Error {
  readonly from: TaskStatus;
  readonly to: TaskStatus;

  constructor(from: TaskStatus, to: TaskStatus) {
    super(`非法状态迁移: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
}

export function allowedTransitions(from: TaskStatus): readonly TaskStatus[] {
  return TRANSITIONS[from];
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** 结果不明时是否允许直接重试：只有 unknown 进来的不行，必须先 verified */
export function isRetryBlockedByVerification(status: TaskStatus): boolean {
  return status === 'unknown' || status === 'dispatching';
}

/**
 * 状态的中文展示名，界面与日志共用一套口径，避免各写各的。
 */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  scheduled: '待发布',
  dispatching: '提交中',
  paused: '已暂停',
  handed_off: '已交接',
  submitted: '已提交',
  under_review: '平台审核中',
  published: '已发布',
  failed: '失败',
  unknown: '待核实',
  verified: '已核实',
  canceled: '已取消',
};
