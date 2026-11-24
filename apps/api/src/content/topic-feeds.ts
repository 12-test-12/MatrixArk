import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { SaxesParser } from 'saxes';
import { z } from 'zod';

export const topicProviders = ['youtube', 'mastodon', 'google-trends', 'rss'] as const;
export const topicSourceSchema = z.object({
  provider: z.enum(topicProviders),
  target: z.string().trim().min(1).max(300),
  keyword: z.string().trim().max(80).default(''),
}).strict();
type Source = z.infer<typeof topicSourceSchema>;

export function getFeed(source: Source) {
  const { provider, target } = source;
  if (provider === 'youtube' && /^UC[\w-]{22}$/.test(target)) {
    const url = new URL('https://www.youtube.com/feeds/videos.xml');
    url.searchParams.set('channel_id', target);
    return url;
  }
  if (provider === 'mastodon') {
    if (/^@[a-z\d_]{1,40}$/i.test(target)) return new URL(`https://mastodon.social/${target}.rss`);
    if (/^#[\p{L}\p{N}_]{1,64}$/u.test(target)) {
      return new URL(`https://mastodon.social/tags/${encodeURIComponent(target.slice(1))}.rss`);
    }
  }
  if (provider === 'google-trends' && /^[A-Z]{2}$/.test(target)) {
    const url = new URL('https://trends.google.com/trending/rss');
    url.searchParams.set('geo', target);
    return url;
  }
  if (provider === 'rss' && process.env.TOPIC_RSS_URLS?.split(',').some((value) => value.trim() === target)) {
    const url = URL.canParse(target) ? new URL(target) : null;
    if (url?.protocol === 'https:' && !url.username && !url.password && !url.hash) return url;
  }
  throw new BadRequestException('采集目标格式不正确，或该订阅地址未获工作台管理员配置');
}

async function readFeedBody(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('来源未返回内容');
  const decoder = new TextDecoder();
  let bytes = 0;
  let xml = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return xml + decoder.decode();
      bytes += value.length;
      if (bytes > 524_288) throw new Error('来源返回内容超过 512 KiB');
      xml += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const paths = new Set(['title', 'id', 'guid', 'yt:videoId', 'link', 'published', 'pubDate',
  'dc:date', 'description', 'summary', 'media:group/media:description', 'author/name', 'dc:creator', 'ht:approx_traffic']);

function sliceText(value: string, start: number, end: number) {
  return value.slice(start, end).replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/gu, '');
}

function parseFeed(xml: string) {
  const output: Record<string, string>[] = [];
  const stack: string[] = [];
  let root = '';
  let row: Record<string, string> | undefined;
  let depth = 0;
  const parser = new SaxesParser();
  parser.on('doctype', () => { throw new Error('订阅源包含不支持的文档类型声明'); });
  parser.on('opentag', (tag) => {
    if (stack.length > 32) throw new Error('订阅源结构过深');
    stack.push(tag.name);
    if (stack.length === 1) root = tag.name;
    if ((root === 'rss' && stack.join('/') === 'rss/channel/item') || stack.join('/') === 'feed/entry') {
      row = {};
      depth = stack.length;
    }
    if (row && stack.length === depth + 1 && tag.name === 'link' && (!tag.attributes.rel || tag.attributes.rel === 'alternate')
      && tag.attributes.href) row.link = tag.attributes.href;
    const field = stack.slice(depth).join('/');
    if (row && ['media:thumbnail', 'media:group/media:thumbnail'].includes(field) && !row.coverUrl && tag.attributes.url) {
      row.coverUrl = tag.attributes.url;
    }
    if (row && field === 'media:group/media:community/media:statistics' && tag.attributes.views) {
      row.views = tag.attributes.views;
    }
  });
  const addText = (value: string) => {
    if (!row) return;
    const field = stack.slice(depth).join('/');
    if (paths.has(field)) row[field] = sliceText((row[field] ?? '') + value, 0, 2200);
  };
  parser.on('text', addText);
  parser.on('cdata', addText);
  parser.on('closetag', () => {
    if (row && stack.length === depth) {
      if (output.length < 100) output.push(row);
      row = undefined;
    }
    stack.pop();
  });
  parser.write(xml).close();
  if (root !== 'rss' && root !== 'feed') throw new Error('来源未返回 RSS 或 Atom 订阅');
  return output;
}

const clean = (value?: string) => value?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() ?? '';
const searchable = (value: string) => value.normalize('NFKC').toLowerCase();

export function matchingEvidence(keyword: string, fields: { title: string; summary: string }, legacy = false) {
  const needle = searchable(keyword);
  if (!needle) return { field: 'source', excerpt: null };
  const pattern = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startBoundary = !legacy && /^[a-z0-9]/.test(needle) ? '(?<![\\p{Script=Latin}\\p{N}_])' : '';
  const endBoundary = !legacy && /[a-z0-9]$/.test(needle) ? '(?![\\p{Script=Latin}\\p{N}_])' : '';
  const matcher = new RegExp(startBoundary + pattern + endBoundary, 'u');
  for (const field of ['title', 'summary'] as const) {
    const raw = fields[field];
    const text = (legacy ? raw : raw.replace(/https?:\/\/[^\s<>]+/gi, '')).normalize('NFKC');
    const index = text.toLowerCase().search(matcher);
    if (index === -1) continue;
    const start = Math.max(0, index - 32);
    const end = index + needle.length + 48;
    return { field, excerpt: (start > 0 ? '…' : '') + sliceText(text, start, end) + (end < text.length ? '…' : '') };
  }
  return null;
}

function feedCover(raw: string | undefined, provider: Source['provider']) {
  if (!raw || raw.length > 2048 || !URL.canParse(raw)) return null;
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (provider === 'youtube' && /^i[1-4]?\.ytimg\.com$/.test(url.hostname) && url.pathname.startsWith('/vi/')) return url.href;
  if (provider === 'mastodon' && url.hostname === 'files.mastodon.social') return url.href;
  return null;
}

export async function collectTopicFeed(source: Source) {
  const url = getFeed(source);
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
      headers: { accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml' },
    });
  } catch {
    throw new Error('订阅源连接失败或超时');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(response.status === 429 ? '来源请求过多，稍后自动重试' : `订阅源返回 HTTP ${response.status}`);
  }
  const rows = parseFeed(await readFeedBody(response));
  return rows.flatMap((row) => {
    const title = clean(row.title);
    const summary = clean(row['media:group/media:description'] ?? row.summary ?? row.description);
    const heat = clean(row['ht:approx_traffic']);
    const description = sliceText([title || summary, title ? summary : '', heat ? `搜索热度 ${heat}` : ''].filter(Boolean).join('\n'), 0, 2000);
    const evidence = matchingEvidence(source.keyword, { title, summary });
    if (!description || !evidence) return [];
    const link = row.link?.trim();
    const parsed = link && URL.canParse(link) ? new URL(link) : null;
    const sourceUrl = parsed?.protocol === 'https:' && !parsed.username && !parsed.password && parsed.href.length <= 2048
      ? parsed.href : null;
    const published = Date.parse(row.published ?? row.pubDate ?? row['dc:date'] ?? '');
    const publishedOn = Number.isFinite(published) ? new Date(new Date(published).toISOString().slice(0, 10)) : null;
    const identity = source.provider === 'google-trends'
      ? [source.target, title, publishedOn?.toISOString()]
      : [row['yt:videoId'] || sourceUrl || row.guid || row.id || title, sourceUrl || row.guid || row.id ? null : publishedOn?.toISOString()];
    const externalId = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const views = source.provider === 'youtube' && /^\d{1,16}$/.test(row.views ?? '') ? Number(row.views) : null;
    return [{
      platform: source.provider, externalId, description, sourceUrl, publishedOn, evidence,
      coverUrl: feedCover(row.coverUrl, source.provider),
      views: views !== null && Number.isSafeInteger(views) ? BigInt(views) : null,
      creator: sliceText(clean(row['author/name'] || row['dc:creator']) || source.target, 0, 120),
      mediaType: source.provider === 'youtube' ? 'video' : 'text',
    }];
  });
}
