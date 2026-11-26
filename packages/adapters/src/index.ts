import type { ChannelKind, Platform } from '@matrixark/shared';
import { BilibiliAdapter } from './bilibili.js';
import { ManualHandoffAdapter } from './manual.js';
import { SandboxAdapter } from './sandbox.js';
import { bilibiliArticlePolicy } from './policies/bilibili-content.js';
import { AdapterRegistry, type AdapterResolverOptions } from './registry.js';
import type { ChannelAdapter, PlatformContentPolicy } from './types.js';

export * from './types.js';
export * from './registry.js';
export { BilibiliAdapter, validateBilibiliArticle } from './bilibili.js';
export { ManualHandoffAdapter } from './manual.js';
export { SandboxAdapter } from './sandbox.js';

const manual = new ManualHandoffAdapter();
const sandbox = new SandboxAdapter();
const trialSandbox = new SandboxAdapter(true);

const handoffContentPolicy: PlatformContentPolicy = {
  supportsVideo: true,
  requiresImageFiles: false,
  validate() {},
};

export function createDefaultAdapterRegistry() {
  return new AdapterRegistry([
    { kind: 'manual', platforms: manual.platforms, contentPolicy: handoffContentPolicy,
      supportsMetrics: false, create: () => manual },
    { kind: 'sandbox', platforms: sandbox.platforms, contentPolicy: handoffContentPolicy,
      supportsMetrics: false, create: (options) => options.trial ? trialSandbox : sandbox },
    { kind: 'official', platforms: ['bilibili'], contentPolicy: bilibiliArticlePolicy,
      supportsMetrics: true, create: (options) => new BilibiliAdapter(options.bilibili ?? {}) },
  ]);
}

const defaultRegistry = createDefaultAdapterRegistry();

/**
 * 通道解析：kind 决定走哪个实现，platform 决定支持与否。
 * 不支持时抛 ChannelNotConfiguredError，调用方据此把任务判为「环境未就绪」。
 */
export function resolveAdapter(
  platform: Platform,
  kind: ChannelKind,
  options: AdapterResolverOptions = {},
): ChannelAdapter {
  return defaultRegistry.resolve(platform, kind, options);
}
