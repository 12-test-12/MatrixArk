import { describe, expect, it } from 'vitest';
import {
  extractHashtags,
  generateVariantDraft,
  normalizeTags,
  truncate,
  validateVariant,
} from '../src/variant-rules.js';

describe('一稿多版规则', () => {
  const manuscript = {
    title: '一个特别长的标题'.repeat(5),
    body: '正文内容。#职场 #效率\n\n结尾一段。',
    tags: ['副业', '效率'],
  };

  it('B 站保留正文原样，不追加话题块', () => {
    const draft = generateVariantDraft(manuscript, 'bilibili');
    expect(draft.body).toContain('结尾一段。');
    expect(draft.tags).toEqual(['副业', '效率', '职场']);
  });

  it('小红书标题被截到 20 字并留省略号', () => {
    const draft = generateVariantDraft(manuscript, 'xiaohongshu');
    expect(Array.from(draft.title).length).toBe(20);
    expect(draft.title.endsWith('…')).toBe(true);
  });

  it('小红书正文不超过 1000 字，且话题块在末尾', () => {
    const long = { ...manuscript, body: '长'.repeat(2000), tags: ['话题一'] };
    const draft = generateVariantDraft(long, 'xiaohongshu');
    expect(Array.from(draft.body).length).toBeLessThanOrEqual(1000);
    expect(draft.body.endsWith('#话题一')).toBe(true);
  });

  it('去重同时保留顺序', () => {
    expect(normalizeTags(['效率', '#效率', '副业'], ['副业', '职场'])).toEqual(['效率', '副业', '职场']);
  });

  it('从正文提取话题', () => {
    expect(extractHashtags('今天聊聊 #副业 #Excel 的事')).toEqual(['副业', 'Excel']);
  });

  it('话题数量超限时截断', () => {
    const many = { ...manuscript, tags: Array.from({ length: 20 }, (_, i) => `tag${i}`) };
    expect(generateVariantDraft(many, 'bilibili').tags.length).toBe(10);
  });

  it('截断按字符而不是字节', () => {
    expect(truncate('😀😀😀😀', 2)).toBe('😀…');
  });
});

describe('发布前校验', () => {
  it('小红书没图直接拦下', () => {
    const issues = validateVariant('xiaohongshu', {
      title: '正常标题',
      body: '正常正文',
      tags: [],
      imageCount: 0,
    });
    expect(issues.map((i) => i.code)).toContain('images_missing');
  });

  it('超长标题给出可读提示', () => {
    const issues = validateVariant('xiaohongshu', {
      title: '标'.repeat(25),
      body: '正文',
      tags: [],
      imageCount: 1,
    });
    expect(issues.some((i) => i.code === 'title_too_long')).toBe(true);
  });

  it('合规内容没有 issue，B 站专栏允许无图纯文本', () => {
    expect(
      validateVariant('bilibili', { title: '标题', body: '正文', tags: ['a'], imageCount: 2 }),
    ).toEqual([]);
    expect(
      validateVariant('bilibili', { title: '标题', body: '正文', tags: ['a'], imageCount: 0 }),
    ).toEqual([]);
  });
});
