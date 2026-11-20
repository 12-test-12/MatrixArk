import { describe, expect, it } from 'vitest';
import { contentHash, idempotencyKey } from '../src/platform.js';

describe('内容指纹与幂等键', () => {
  const base = { platform: 'bilibili' as const, title: '标题', body: '正文', tags: ['a', 'b'] };

  it('相同内容得到相同指纹', () => {
    expect(contentHash(base)).toBe(contentHash({ ...base, tags: ['a', 'b'] }));
  });

  it('空白差异不影响指纹', () => {
    expect(contentHash(base)).toBe(contentHash({ ...base, title: ' 标题 ', body: '正文 ' }));
  });

  it('改一个字指纹就变（改稿后可重新提交）', () => {
    expect(contentHash(base)).not.toBe(contentHash({ ...base, body: '正文2' }));
  });

  it('标签顺序参与指纹', () => {
    expect(contentHash(base)).not.toBe(contentHash({ ...base, tags: ['b', 'a'] }));
  });

  it('同一账号同一版本同一时间点，幂等键稳定', () => {
    const input = {
      accountId: 'acc-1',
      variantId: 'var-1',
      hash: contentHash(base),
      scheduledAt: new Date('2026-11-20T10:00:00+08:00'),
    };
    expect(idempotencyKey(input)).toBe(idempotencyKey({ ...input }));
  });

  it('换账号、换版本、换时间点都会换键', () => {
    const input = {
      accountId: 'acc-1',
      variantId: 'var-1',
      hash: 'h',
      scheduledAt: new Date('2026-11-20T10:00:00+08:00'),
    };
    const key = idempotencyKey(input);
    expect(idempotencyKey({ ...input, accountId: 'acc-2' })).not.toBe(key);
    expect(idempotencyKey({ ...input, variantId: 'var-2' })).not.toBe(key);
    expect(idempotencyKey({ ...input, scheduledAt: new Date('2026-11-20T10:01:00+08:00') })).not.toBe(key);
  });
});
