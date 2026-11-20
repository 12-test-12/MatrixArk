import type { ChannelAdapter, PublishInput, PublishReceipt } from './types.js';

/**
 * 沙箱通道：B 站权限没下来之前，用它把流程和幂等逻辑跑通。
 * 结果由幂等键决定，因此同一任务重复提交得到同一结果 —— 这样测「防重复发稿」才有意义。
 */
export class SandboxAdapter implements ChannelAdapter {
  readonly kind = 'sandbox' as const;
  readonly platforms = ['bilibili', 'xiaohongshu'] as const;

  private readonly statusCalls = new Map<string, number>();

  async preflight(): Promise<void> {}

  async publish(input: PublishInput): Promise<PublishReceipt> {
    const bucket = pickBucket(input.slot.idempotencyKey);
    const remoteId = `sandbox-${input.slot.idempotencyKey.slice(0, 12)}`;

    switch (bucket) {
      case 0:
        return { status: 'published', remoteId, remoteUrl: `https://example.invalid/${remoteId}` };
      case 1:
        return { status: 'submitted', remoteId, message: '沙箱：已受理，等待平台审核' };
      case 2:
        return { status: 'failed', remoteId, message: '沙箱：平台返回审核不通过（模拟）' };
      default:
        return { status: 'unknown', remoteId, message: '沙箱：提交超时，需核对结果' };
    }
  }

  async fetchStatus(receipt: PublishReceipt): Promise<PublishReceipt> {
    const key = receipt.remoteId ?? 'unknown';
    const calls = (this.statusCalls.get(key) ?? 0) + 1;
    this.statusCalls.set(key, calls);

    // 第一次查到「审核中」，第二次才给结论 —— 逼着调用方真的做轮询而不是一把梭
    if (calls === 1) {
      return { ...receipt, status: 'under_review', message: '沙箱：平台审核中' };
    }
    return {
      ...receipt,
      status: 'published',
      remoteUrl: `https://example.invalid/${key}`,
      message: '沙箱：审核通过，已发布',
    };
  }
}

function pickBucket(idempotencyKey: string): number {
  let sum = 0;
  for (const char of idempotencyKey) sum = (sum + char.charCodeAt(0)) % 9973;
  return sum % 4;
}
