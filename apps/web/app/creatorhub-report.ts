export const topicPlatforms = {
  bilibili: 'B 站', xiaohongshu: '小红书', douyin: '抖音', kuaishou: '快手', shipinhao: '视频号',
  rednote: '海外小红书', tiktok: 'TikTok', instagram: 'Instagram', twitter: 'X',
};
export const topicMediaTypes = { video: '视频', images: '图文', text: '文字', other: '其他' };

export type ImportedWork = {
  platform: keyof typeof topicPlatforms;
  externalId: string;
  creatorId: string | null;
  creator: string | null;
  description: string;
  mediaType: keyof typeof topicMediaTypes;
  sourceUrl: string;
  publishedOn: string | null;
  likes: number | null;
  comments: number | null;
};
export type TopicWork = ImportedWork & { id: string; importedAt: string; savedAt: string | null; note: string | null };

function text(value: unknown, max: number) {
  return typeof value === 'string'
    ? value.replaceAll('\0', '').trim().slice(0, max).replace(/[\uD800-\uDBFF]$/, '') : '';
}

function identifier(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  const result = text(value, 129);
  return result.length <= 128 ? result : '';
}

function metric(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : null;
}

export function parseCreatorHubWorks(rows: ReadonlyArray<ReadonlyArray<unknown>>) {
  const [header, ...body] = rows;
  const required = ['平台', '作品ID', '描述', '作者', '媒体类型', '发布时间', '作品链接'];
  if (!header || !required.every((name) => header.includes(name))) {
    throw new Error('找不到 CreatorHub 采集报告字段，请上传带有「作品」工作表的 Excel 报告。');
  }
  const columns = new Map(header.map((name, index) => [name, index]));
  const works = new Map<string, ImportedWork>();
  let skipped = 0;
  for (const row of body) {
    if (row.every((cell) => cell === null || cell === undefined || cell === '')) continue;
    const read = (name: string) => row[columns.get(name) ?? -1];
    const platformCell = text(read('平台'), 30).toLowerCase();
    const platform = (platformCell === 'xhs' ? 'xiaohongshu' : platformCell) as ImportedWork['platform'];
    const externalId = identifier(read('作品ID'));
    const source = text(read('作品链接'), 2049);
    const url = URL.canParse(source) ? new URL(source) : undefined;
    if (!Object.hasOwn(topicPlatforms, platform) || !externalId || !url || url.href.length > 2048
      || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      skipped++;
      continue;
    }
    const type = text(read('媒体类型'), 30);
    const mediaType = (Object.hasOwn(topicMediaTypes, type) ? type : 'other') as ImportedWork['mediaType'];
    const day = read('发布时间');
    works.set(JSON.stringify([platform, externalId]), {
      platform, externalId, mediaType, sourceUrl: url.href,
      creatorId: identifier(read('作者ID')) || null,
      creator: text(read('作者'), 120) || null,
      description: text(read('描述'), 2000),
      // CreatorHub stores the exporting machine's wall-clock date without a timezone.
      publishedOn: day instanceof Date && Number.isFinite(day.getTime()) ? day.toISOString().slice(0, 10) : null,
      likes: metric(read('点赞数')),
      comments: metric(read('平台评论数')),
    });
  }
  return { works: [...works.values()], skipped };
}
