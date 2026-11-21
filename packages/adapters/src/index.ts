import type { ChannelKind, Platform } from '@matrixark/shared';
import { BilibiliAdapter } from './bilibili.js';
import { ManualHandoffAdapter } from './manual.js';
import { SandboxAdapter } from './sandbox.js';
import { ChannelNotConfiguredError, type ChannelAdapter } from './types.js';

export * from './types.js';
export { BilibiliAdapter, validateBilibiliArticle } from './bilibili.js';
export { ManualHandoffAdapter } from './manual.js';
export { SandboxAdapter } from './sandbox.js';

const manual = new ManualHandoffAdapter();
const sandbox = new SandboxAdapter();

export interface AdapterResolverOptions {
  /** 全局强制走沙箱：联调与演示阶段用，避免误发真实内容 */
  forceSandbox?: boolean;
  bilibili?: ConstructorParameters<typeof BilibiliAdapter>[0];
}

/**
 * 通道解析：kind 决定走哪个实现，platform 决定支持与否。
 * 不支持时抛 ChannelNotConfiguredError，调用方据此把任务判为「环境未就绪」。
 */
export function resolveAdapter(
  platform: Platform,
  kind: ChannelKind,
  options: AdapterResolverOptions = {},
): ChannelAdapter {
  if (options.forceSandbox && kind !== 'manual') return sandbox;
  if (kind === 'manual') return manual;
  if (kind === 'sandbox') return sandbox;
  if (platform === 'bilibili') return new BilibiliAdapter(options.bilibili ?? {});
  throw new ChannelNotConfiguredError(`平台 ${platform} 暂无官方通道实现`);
}
