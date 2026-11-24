export const topicPlatforms = {
  bilibili: 'B 站', xiaohongshu: '小红书', douyin: '抖音', kuaishou: '快手', shipinhao: '视频号',
  rednote: '海外小红书', tiktok: 'TikTok', instagram: 'Instagram', twitter: 'X',
  youtube: 'YouTube', mastodon: 'Mastodon', 'google-trends': 'Google 热搜', rss: 'RSS 订阅',
};
export const topicMediaTypes = { video: '视频', images: '图文', text: '文字', other: '其他' };

const platformAliases: Record<string, keyof typeof topicPlatforms> = {
  bilibili: 'bilibili', 'b 站': 'bilibili', 'b站': 'bilibili', '哔哩哔哩': 'bilibili',
  xiaohongshu: 'xiaohongshu', xhs: 'xiaohongshu', '小红书': 'xiaohongshu',
  douyin: 'douyin', '抖音': 'douyin',
  kuaishou: 'kuaishou', '快手': 'kuaishou',
  shipinhao: 'shipinhao', '视频号': 'shipinhao', '微信视频号': 'shipinhao',
  rednote: 'rednote', '海外小红书': 'rednote',
  tiktok: 'tiktok',
  instagram: 'instagram', ins: 'instagram',
  twitter: 'twitter', x: 'twitter',
};

const mediaTypeAliases: Record<string, keyof typeof topicMediaTypes> = {
  video: 'video', '视频': 'video',
  images: 'images', image: 'images', '图文': 'images', '图集': 'images', '图片': 'images',
  text: 'text', '文字': 'text', '文本': 'text',
  other: 'other', '其他': 'other',
};

export type ImportedWork = {
  platform: keyof typeof topicPlatforms;
  externalId: string;
  creatorId: string | null;
  creator: string | null;
  description: string;
  mediaType: keyof typeof topicMediaTypes;
  sourceUrl: string | null;
  publishedOn: string | null;
  likes: number | null;
  comments: number | null;
};
export type TopicWork = ImportedWork & {
  id: string;
  importedAt: string;
  savedAt: string | null;
  note: string | null;
  coverUrl?: string | null;
  views?: number | null;
  origin?: 'feed' | 'report' | 'legacy';
  matches?: {
    field: 'source' | 'title' | 'summary';
    excerpt: string | null;
    seenAt: string;
    source: { id: string; provider: ImportedWork['platform']; target: string; keyword: string };
  }[];
};

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
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const num = Number(value.trim());
    if (Number.isSafeInteger(num) && num >= 0 && num <= 2_147_483_647) return num;
  }
  return null;
}

export function parseExcelSerialDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  if (serial > 1_000_000_000_000) {
    const d = new Date(serial);
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
  }
  if (serial > 1_000_000_000) {
    const d = new Date(serial * 1000);
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
  }
  const utcDays = Math.floor(serial);
  const ms = (utcDays - 25569) * 86400 * 1000;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

export function parseDateCell(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number') {
    return parseExcelSerialDate(value);
  }
  if (typeof value === 'string') {
    const str = value.trim();
    if (!str) return null;
    if (/^\d+(\.\d+)?$/.test(str)) {
      const num = Number(str);
      if (Number.isFinite(num)) {
        const res = parseExcelSerialDate(num);
        if (res) return res;
      }
    }
    const normalized = str
      .replace(/年|\/|\./g, '-')
      .replace(/月/g, '-')
      .replace(/日.*/, '')
      .trim();
    const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (match) {
      const year = match[1];
      const month = match[2]!.padStart(2, '0');
      const day = match[3]!.padStart(2, '0');
      const d = new Date(`${year}-${month}-${day}T00:00:00Z`);
      if (Number.isFinite(d.getTime())) return `${year}-${month}-${day}`;
    }
    const parsed = new Date(str);
    if (Number.isFinite(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  return null;
}

export function parseCreatorHubWorks(rows: ReadonlyArray<ReadonlyArray<unknown>>) {
  const [header, ...body] = rows;
  const columnKey = (name: unknown) => text(name, 100).replace(/\s/g, '').toLowerCase();
  const columns = new Map(header?.map((name, index) => [columnKey(name), index]));
  if (!columns.has('平台') || !columns.has('作品id')) {
    throw new Error('工作表缺少「平台」或「作品ID」列，请重新导出 CreatorHub 作品报表。');
  }
  const works = new Map<string, ImportedWork>();
  let skipped = 0;
  let missingDates = 0;
  for (const row of body) {
    if (row.every((cell) => cell === null || cell === undefined || cell === '')) continue;
    const read = (name: string) => row[columns.get(columnKey(name)) ?? -1];
    const rawPlatform = text(read('平台'), 30).toLowerCase();
    const platform = Object.hasOwn(platformAliases, rawPlatform) ? platformAliases[rawPlatform] : undefined;
    const externalId = identifier(read('作品ID'));
    const source = text(read('作品链接') ?? read('来源链接'), 2049);
    const url = URL.canParse(source) ? new URL(source) : undefined;
    if (!platform || !externalId || (source && (!url || url.href.length > 2048
      || !['https:', 'http:'].includes(url.protocol) || url.username || url.password))) {
      skipped++;
      continue;
    }
    const rawType = text(read('媒体类型'), 30).toLowerCase();
    const mediaType = Object.hasOwn(mediaTypeAliases, rawType) ? mediaTypeAliases[rawType]! : 'other';
    const day = read('发布时间') ?? read('发布日期') ?? read('发表时间');
    const publishedOn = parseDateCell(day);
    if (!publishedOn) missingDates++;

    works.set(JSON.stringify([platform, externalId]), {
      platform, externalId, mediaType, sourceUrl: url?.href ?? null,
      creatorId: identifier(read('作者ID')) || null,
      creator: text(read('作者') ?? read('监控目标'), 120) || null,
      description: text(read('描述') ?? read('作品描述'), 2000),
      publishedOn,
      likes: metric(read('点赞数')),
      comments: metric(read('平台评论数') ?? read('评论数')),
    });
  }
  return { works: [...works.values()], skipped, missingDates };
}

export async function readCreatorHubReport(file: Blob) {
  const { readSheet } = await import('read-excel-file/browser');
  for (const name of ['作品', '作品数据']) {
    let rows;
    try {
      rows = await readSheet(file, name);
    } catch (error) {
      if (error instanceof Error && error.name === 'SheetNotFoundError') continue;
      throw new Error('无法打开这份 .xlsx 文件，请在 CreatorHub 重新导出 Excel 报表。');
    }
    if (rows.length === 0) throw new Error('作品工作表为空，请导出包含作品的报表。');
    if (rows.length > 1001) throw new Error('单次最多导入 1000 行，请分批导出。');
    return parseCreatorHubWorks(rows);
  }
  throw new Error('文件里找不到「作品」或「作品数据」工作表。请选择 CreatorHub 的采集任务报告或监控作品报表。');
}
