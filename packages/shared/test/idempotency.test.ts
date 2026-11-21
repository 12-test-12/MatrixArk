import { describe, expect, it } from 'vitest';
import { contentHash, idempotencyKey } from '../src/platform.js';

describe('内容指纹与幂等键', () => {
  const base = {
    platform: 'bilibili' as const,
    title: '标题',
    body: '正文',
    tags: ['a', 'b'],
    assets: [
      { assetId: 'a', position: 0, isCover: true },
      { assetId: 'b', position: 1, isCover: false },
    ],
    platformFields: {},
  };

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

  it('图片顺序、封面和平台字段参与指纹，但行返回顺序和对象键顺序不影响指纹', () => {
    const snapshot = { ...base, platformFields: { data: { 10: 'a', 2: 'b', enabled: true }, summary: '正文' } };
    expect(contentHash(snapshot)).toBe(contentHash({
      ...snapshot,
      assets: [...snapshot.assets].reverse(),
      platformFields: { summary: '正文', data: { enabled: true, 2: 'b', 10: 'a' } },
    }));
    expect(contentHash(snapshot)).not.toBe(contentHash({
      ...snapshot,
      assets: snapshot.assets.map((asset) => ({ ...asset, position: 1 - asset.position })),
    }));
    expect(contentHash(snapshot)).not.toBe(contentHash({
      ...snapshot,
      assets: snapshot.assets.map((asset) => ({ ...asset, isCover: !asset.isCover })),
    }));
    expect(contentHash(snapshot)).not.toBe(contentHash({
      ...snapshot,
      platformFields: { ...snapshot.platformFields, summary: '新摘要' },
    }));
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
