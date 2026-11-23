import { describe, expect, it } from 'vitest';
import {
  IllegalTransitionError,
  TASK_STATUSES,
  assertTransition,
  canTransition,
  isRetryBlockedByVerification,
  isTerminal,
} from '../src/status.js';

describe('任务状态机', () => {
  it('正常链路: 排期 -> 提交中 -> 已交接 -> 已发布', () => {
    assertTransition('scheduled', 'dispatching');
    assertTransition('dispatching', 'handed_off');
    assertTransition('handed_off', 'published');
  });

  it('官方通道: 已提交 -> 平台审核中 -> 已发布', () => {
    assertTransition('dispatching', 'submitted');
    assertTransition('submitted', 'under_review');
    assertTransition('under_review', 'published');
  });

  it('待核实不能直接重试，必须先核实', () => {
    expect(canTransition('unknown', 'scheduled')).toBe(false);
    expect(canTransition('unknown', 'dispatching')).toBe(false);
    expect(canTransition('unknown', 'verified')).toBe(true);
    expect(isRetryBlockedByVerification('unknown')).toBe(true);
    expect(canTransition('failed', 'scheduled')).toBe(false);
  });

  it('核实后可按结论走发布或重试', () => {
    assertTransition('verified', 'published');
    assertTransition('verified', 'scheduled');
    assertTransition('verified', 'failed');
    assertTransition('verified', 'submitted');
  });

  it('已发布与已取消停止派发，已取消仅允许更正为已发布', () => {
    expect(isTerminal('published')).toBe(true);
    expect(isTerminal('canceled')).toBe(true);
    for (const to of TASK_STATUSES) {
      expect(canTransition('published', to)).toBe(false);
      expect(canTransition('canceled', to)).toBe(to === 'published');
    }
  });

  it('提交中不能直接回到排期（防止重复提交）', () => {
    expect(canTransition('dispatching', 'scheduled')).toBe(false);
    expect(canTransition('dispatching', 'paused')).toBe(false);
  });

  it('非法迁移抛出可识别的错误', () => {
    expect(() => assertTransition('published', 'scheduled')).toThrow(IllegalTransitionError);
    try {
      // 已交接的任务不能再回到「已暂停」，否则改稿会绕过已确认的版本
      assertTransition('handed_off', 'paused');
    } catch (error) {
      expect((error as IllegalTransitionError).from).toBe('handed_off');
      expect((error as IllegalTransitionError).to).toBe('paused');
    }
  });

  it('每个状态都至少有一条出边或明确终态', () => {
    for (const status of TASK_STATUSES) {
      if (isTerminal(status)) continue;
      const hasOutgoing = TASK_STATUSES.some((to) => canTransition(status, to));
      expect(hasOutgoing, `${status} 没有出边也不是终态`).toBe(true);
    }
  });
});
