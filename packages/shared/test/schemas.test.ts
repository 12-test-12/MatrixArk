import { describe, expect, it } from 'vitest';
import { recordResultSchema, scheduleTasksSchema } from '../src/schemas.js';

describe('任务与回执校验规则', () => {
  it('排期时间必须是带时区的合法 ISO 字符串', () => {
    const valid = {
      variantIds: ['a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d'],
      accountIds: ['b1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6e'],
      scheduledAt: '2026-11-21T12:00:00+08:00',
    };
    expect(scheduleTasksSchema.safeParse(valid).success).toBe(true);
    expect(scheduleTasksSchema.safeParse({ ...valid, scheduledAt: 'invalid' }).success).toBe(false);
  });

  it('已发布必须提供作品链接或截图', () => {
    const evidenceAssetId = 'c1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6f';
    expect(recordResultSchema.safeParse({ state: 'published' }).success).toBe(false);
    expect(recordResultSchema.safeParse({
      state: 'published',
      remoteUrl: 'https://www.xiaohongshu.com/discovery/item/12345',
    }).success).toBe(true);
    expect(recordResultSchema.safeParse({
      state: 'published',
      evidenceAssetId,
    }).success).toBe(true);
  });

  it('作品链接带有空白时正常修剪，仅传空白链接加截图时不应报错', () => {
    const evidenceAssetId = 'c1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6f';
    const parsed = recordResultSchema.safeParse({
      state: 'published',
      remoteUrl: '   ',
      evidenceAssetId,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.remoteUrl).toBe('');
    }
  });

  it('拒绝非 HTTP/HTTPS 协议及凭据伪装链接', () => {
    expect(recordResultSchema.safeParse({
      state: 'published',
      remoteUrl: 'javascript:alert(1)',
    }).success).toBe(false);
    expect(recordResultSchema.safeParse({
      state: 'published',
      remoteUrl: 'https://user:pass@example.com',
    }).success).toBe(false);
  });

  it('失败与待核实允许不提供链接和截图', () => {
    expect(recordResultSchema.safeParse({ state: 'failed', note: '账号受限' }).success).toBe(true);
    expect(recordResultSchema.safeParse({ state: 'unknown', note: '发布超时待查' }).success).toBe(true);
  });
});
