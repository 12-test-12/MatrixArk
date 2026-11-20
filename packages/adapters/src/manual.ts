import type { ChannelAdapter, PublishInput, PublishReceipt } from './types.js';

/**
 * 人工交接通道：不发任何请求，只把「已审稿的成品 + 该发到哪」交给运营。
 * 交接单的内容由 API 层渲染，这里只负责把任务推到「已交接」。
 */
export class ManualHandoffAdapter implements ChannelAdapter {
  readonly kind = 'manual' as const;
  readonly platforms = ['bilibili', 'xiaohongshu'] as const;

  async preflight(): Promise<void> {
    // 人工通道没有平台侧前置条件，缺的只是运营的动作
  }

  async publish(input: PublishInput): Promise<PublishReceipt> {
    return {
      status: 'handed_off',
      remoteId: undefined,
      message: `已交接给账号「${input.account.displayName}」的运营`,
    };
  }

  async fetchStatus(receipt: PublishReceipt): Promise<PublishReceipt> {
    // 人工通道的「核实」就是回去问运营，系统无法自动判断
    return { ...receipt, status: 'unknown', message: '人工通道需人工核对后回填' };
  }
}
