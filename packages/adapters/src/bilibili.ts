import {
  ChannelNotConfiguredError,
  type ChannelAdapter,
  type PublishInput,
  type PublishReceipt,
} from './types.js';

/**
 * B 站专栏官方通道。
 *
 * 说明：接口地址与字段以开放平台文档为准（提交/状态查询两个接口都需要单独申请权限）：
 * https://open.bilibili.com/doc/4/b14b77b6-8889-8c8b-2e83-17c5a4c550fb
 * https://open.bilibili.com/doc/4/46903ddc-1264-ddac-a3c7-559d12f32118
 *
 * 权限下来之前，地址留空 -> 直接抛 ChannelNotConfiguredError，
 * 让任务停在「失败（环境未就绪）」而不是伪装成「已提交」，避免假数据污染试点结论。
 */
export interface BilibiliEndpoints {
  submitUrl?: string;
  statusUrl?: string;
  timeoutMs?: number;
}

export class BilibiliAdapter implements ChannelAdapter {
  readonly kind = 'official' as const;
  readonly platforms = ['bilibili'] as const;

  constructor(private readonly endpoints: BilibiliEndpoints = {}) {}

  async preflight(input: PublishInput): Promise<void> {
    if (!input.account.credentials?.['access_token']) {
      throw new ChannelNotConfiguredError('账号未绑定 B 站开放平台 access_token');
    }
  }

  async publish(input: PublishInput): Promise<PublishReceipt> {
    const token = input.account.credentials?.['access_token'];
    if (!token) throw new ChannelNotConfiguredError('账号未绑定 B 站开放平台 access_token');
    if (!this.endpoints.submitUrl) {
      throw new ChannelNotConfiguredError(
        'B 站开放平台提交地址未配置（BILIBILI_SUBMIT_URL），请先取得专栏投稿权限',
      );
    }

    const payload = {
      title: input.variant.title,
      content: input.variant.body,
      tags: input.variant.tags.join(','),
      image_urls: input.variant.imageUrls.join(','),
      client_token: input.slot.idempotencyKey,
    };

    return this.request(this.endpoints.submitUrl, token, payload, input.slot.idempotencyKey);
  }

  async fetchStatus(
    receipt: PublishReceipt,
    account: PublishInput['account'],
  ): Promise<PublishReceipt> {
    const token = account.credentials?.['access_token'];
    if (!token) throw new ChannelNotConfiguredError('账号未绑定 B 站开放平台 access_token');
    if (!this.endpoints.statusUrl || !receipt.remoteId) {
      return { ...receipt, status: 'unknown', message: '状态查询未配置或缺少 remoteId' };
    }
    return this.request(
      `${this.endpoints.statusUrl}?aid=${encodeURIComponent(receipt.remoteId)}`,
      token,
      undefined,
      undefined,
    );
  }

  private async request(
    url: string,
    token: string,
    body: unknown,
    idempotencyKey: string | undefined,
  ): Promise<PublishReceipt> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    if (idempotencyKey) headers['x-idempotency-key'] = idempotencyKey;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.endpoints.timeoutMs ?? 15000),
      });
    } catch (error) {
      // 超时/网络中断：结果不明，必须走「待核实」，绝不能当失败去重试
      return {
        status: 'unknown',
        message: `提交结果不明：${(error as Error).message}`,
      };
    }

    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 平台偶尔返回 HTML 错误页，保留原文便于排查
    }

    if (!response.ok) {
      return {
        status: response.status >= 500 ? 'unknown' : 'failed',
        message: `B 站返回 HTTP ${response.status}`,
        raw: parsed,
      };
    }

    const data = parsed as { code?: number; message?: string; data?: { aid?: number; bvid?: string } };
    if (data?.code !== 0) {
      return {
        status: 'failed',
        message: `B 站业务错误 ${data?.code ?? '?'}: ${data?.message ?? '未知'}`,
        raw: parsed,
      };
    }

    const aid = data.data?.aid;
    return {
      status: 'submitted',
      remoteId: aid === undefined ? undefined : String(aid),
      remoteUrl: data.data?.bvid
        ? `https://www.bilibili.com/read/cv${data.data.bvid}`
        : undefined,
      message: '已提交 B 站审核',
      raw: parsed,
    };
  }
}
