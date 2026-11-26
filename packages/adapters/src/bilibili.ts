import { articleFields, articleId, record } from './policies/bilibili-content.js';
export { validateBilibiliArticle } from './policies/bilibili-content.js';
import { request as httpsRequest } from 'node:https';
import { biliSignedHeaders } from './bilibili-signature.js';
import { ChannelNotConfiguredError, type ChannelAdapter, type PublishInput, type PublishReceipt } from './types.js';

const host = 'https://member.bilibili.com';
const uploadPath = '/arcopen/fn/article/upload/image';
const submitPath = '/arcopen/fn/article/add';
const statusPath = '/arcopen/fn/data/art/stat';
const receiptIdPattern = /^[1-9]\d{0,19}$/;

type Reply = { code?: unknown; request_id?: unknown; data?: unknown };
type Transport = (path: string, method: 'GET' | 'POST', form: FormData | undefined, headers: Record<string, string>,
  signal: AbortSignal) => Promise<{ status: number; reply: Reply }>;

function escapeHtml(text: string) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function imageUrl(value: unknown) {
  if (typeof value !== 'string' || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.hdslb.com') || url.username || url.password) return undefined;
  return url.href;
}

function receiptDetails(reply: Reply, extra: Record<string, number> = {}) {
  return {
    ...extra,
    ...(typeof reply.code === 'number' ? { platformCode: reply.code } : {}),
    ...(typeof reply.request_id === 'string' && /^[\w-]{1,80}$/.test(reply.request_id) ? { requestId: reply.request_id } : {}),
  };
}

async function request(path: string, method: 'GET' | 'POST', form: FormData | undefined,
  headers: Record<string, string>, signal: AbortSignal) {
  const encoded = form ? new Response(form) : undefined;
  const contents = encoded ? Buffer.from(await encoded.arrayBuffer()) : undefined;
  // The article statistics API requires a GET body, which fetch does not support.
  return new Promise<{ status: number; reply: Reply }>((resolve, reject) => {
    const req = httpsRequest(host + path, {
      method, signal, headers: {
        ...headers, 'Content-Type': encoded?.headers.get('content-type') ?? 'application/json',
        ...(contents ? { 'Content-Length': contents.length } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let bytesRead = 0;
      res.on('data', (chunk: Buffer) => {
        bytesRead += chunk.length;
        if (bytesRead > 1024 * 1024) {
          res.destroy(new Error('B 站响应过大'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, reply: record(JSON.parse(Buffer.concat(chunks).toString('utf8'))) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.end(contents);
  });
}

export class BilibiliAdapter implements ChannelAdapter {
  readonly kind = 'official' as const;
  readonly platforms = ['bilibili'] as const;

  constructor(private readonly options: { clientId?: string; clientSecret?: string; transport?: Transport } = {}) {}

  private token(account: Pick<PublishInput['account'], 'credentials'>) {
    const token = account.credentials?.access_token;
    if (!this.options.clientId || !this.options.clientSecret || !token) {
      throw new ChannelNotConfiguredError('B 站专栏应用或账号授权未配置');
    }
    return token;
  }

  async preflight(input: PublishInput) {
    this.token(input.account);
    articleFields(input.variant);
    for (const { file } of input.variant.images ?? []) {
      if (!['image/jpeg', 'image/png'].includes(file.type) || file.size === 0 || file.size > 5 * 1024 * 1024) {
        throw new Error('B 站专栏图片须为不超过 5 MiB 的 JPEG 或 PNG');
      }
    }
  }

  async authorizedAccount(accessToken: string) {
    const account = { credentials: { access_token: accessToken } };
    const [identity, grant] = await Promise.all([
      this.call('/arcopen/fn/user/account/info', 'GET', undefined, account),
      this.call('/arcopen/fn/user/account/scopes', 'GET', undefined, account),
    ]);
    const { openid, name } = record(identity.reply.data);
    const { scopes, openid: grantId } = record(grant.reply.data);
    if (identity.status !== 200 || identity.reply.code !== 0 || grant.status !== 200 || grant.reply.code !== 0
      || typeof openid !== 'string' || !/^[\w-]{1,256}$/.test(openid) || openid !== grantId
      || typeof name !== 'string' || !name.trim()
      || !Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string')
      || !scopes.includes('ATC_BASE') || !scopes.includes('ATC_DATA')) {
      throw new Error('B 站账号身份核验失败，或未授予专栏投稿与数据回读权限');
    }
    return { openid, name: name.trim(), scopes: scopes as string[] };
  }

  async publish(input: PublishInput): Promise<PublishReceipt> {
    await this.preflight(input);
    const { variant, account, beforeSubmit } = input;
    const { category, summary } = articleFields(variant);
    const timeout = AbortSignal.timeout(60_000);
    const urls: string[] = [];
    let cover: string | undefined;
    for (const image of variant.images ?? []) {
      const form = new FormData();
      form.set('file', image.file, image.file.type === 'image/png' ? 'image.png' : 'image.jpg');
      const upload = await this.call(uploadPath, 'POST', form, account, timeout).catch(() => undefined);
      const url = imageUrl(record(upload?.reply.data).url);
      if (!upload || upload.status !== 200 || upload.reply.code !== 0 || !url) {
        return { status: 'failed', message: 'B 站图片上传失败，文章尚未提交',
          raw: upload ? receiptDetails(upload.reply, { httpStatus: upload.status }) : undefined };
      }
      urls.push(url);
      if (image.isCover) cover = url;
    }
    const form = new FormData();
    form.set('title', variant.title.trim());
    form.set('category', category);
    form.set('template_id', cover ? '4' : '5');
    form.set('summary', summary);
    form.set('content', variant.body.split(/\r?\n/u).map((line) => `<p>${escapeHtml(line)}</p>`).join('')
      + urls.map((url) => `<p><img src="${escapeHtml(url)}"></p>`).join(''));
    if (cover) form.set('image_urls', cover);
    if (variant.tags.length) form.set('tags', variant.tags.join(','));
    if (beforeSubmit && !(await beforeSubmit())) {
      return { status: 'unknown', message: '领取已失效，未继续提交' };
    }
    const submitted = await this.call(submitPath, 'POST', form, account, timeout).catch(() => undefined);
    if (!submitted) return { status: 'unknown', message: 'B 站提交结果未确认' };
    const { status, reply } = submitted;
    const raw = receiptDetails(reply, { httpStatus: status });
    if (status === 200 && reply.code === 0) {
      const id = articleId(record(reply.data).id);
      return id
        ? { status: 'submitted', remoteId: id, message: 'B 站已受理专栏投稿', raw }
        : { status: 'unknown', message: 'B 站返回受理但缺少文章 ID', raw };
    }
    if (status === 200 && typeof reply.code === 'number' && reply.code !== 129000) {
      return { status: 'failed', message: `B 站拒绝投稿（${reply.code}）`, raw };
    }
    return { status: 'unknown', message: 'B 站提交结果未确认', raw };
  }

  async fetchStatus(receipt: PublishReceipt, account: PublishInput['account']): Promise<PublishReceipt> {
    if (!receipt.remoteId) return receipt;
    const article = await this.readArticleStats(receipt.remoteId, account);
    if (!article) return receipt;
    const { data, reply } = article;
    const state = data.state;
    if (typeof state !== 'number') return receipt;
    const raw = receiptDetails(reply, { platformState: state });
    const publishedAt = typeof data.publish_time === 'number' && data.publish_time > 0 && data.publish_time < 8_640_000_000_000
      ? new Date(data.publish_time * 1000) : undefined;
    if (state === 0 && publishedAt) {
      return { status: 'published', remoteId: receipt.remoteId, raw,
        remoteUrl: `https://www.bilibili.com/read/cv${receipt.remoteId}`, platformPublishedAt: publishedAt.toISOString() };
    }
    if (state !== 0 && typeof data.reason === 'string' && data.reason.trim() && !publishedAt) {
      return { status: 'failed', remoteId: receipt.remoteId, raw, message: 'B 站回执显示文章已被打回' };
    }
    return receipt.status === 'submitted'
      ? { status: 'under_review', remoteId: receipt.remoteId, raw, message: '文章尚未确认发表' }
      : receipt;
  }

  async fetchMetrics(remoteId: string, account: Pick<PublishInput['account'], 'credentials'>) {
    return this.fetchArticleMetrics(remoteId, account);
  }

  async fetchArticleMetrics(remoteId: string, account: Pick<PublishInput['account'], 'credentials'>) {
    const article = await this.readArticleStats(remoteId, account);
    if (!article) return undefined;
    const stats = record(article.data.stats);
    const count = (value: unknown) => typeof value === 'number' && Number.isInteger(value)
      && value >= 0 && value <= 2_147_483_647 ? value : null;
    const metrics = { views: count(stats.view), likes: count(stats.like), comments: count(stats.reply),
      favorites: count(stats.favorite), shares: count(stats.share) };
    if (Object.values(metrics).every((value) => value === null)) return undefined;
    return metrics;
  }

  private async readArticleStats(remoteId: string, account: Pick<PublishInput['account'], 'credentials'>) {
    if (!receiptIdPattern.test(remoteId)) return undefined;
    const form = new FormData();
    form.set('ids', remoteId);
    const response = await this.call(statusPath, 'GET', form, account).catch(() => undefined);
    if (!response || response.status !== 200 || response.reply.code !== 0) return undefined;
    const data = record(record(response.reply.data)[remoteId]);
    return articleId(data.id) === remoteId ? { data, reply: response.reply } : undefined;
  }

  private call(path: string, method: 'GET' | 'POST', form: FormData | undefined,
    account: Pick<PublishInput['account'], 'credentials'>, overall?: AbortSignal) {
    const token = this.token(account);
    const deadline = AbortSignal.timeout(12_000);
    const signal = overall ? AbortSignal.any([deadline, overall]) : deadline;
    // The official add/stat examples sign the empty string for multipart. Image upload has only a binary field.
    return (this.options.transport ?? request)(path, method, form,
      biliSignedHeaders(this.options.clientId!, this.options.clientSecret!, token, ''), signal);
  }
}
