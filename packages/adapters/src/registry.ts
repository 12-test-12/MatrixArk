import type { ChannelKind, Platform } from '@matrixark/shared';
import type { BilibiliAdapter } from './bilibili.js';
import { ChannelNotConfiguredError, type ChannelAdapter, type PlatformContentPolicy } from './types.js';

export interface AdapterResolverOptions {
  forceSandbox?: boolean;
  trial?: boolean;
  bilibili?: ConstructorParameters<typeof BilibiliAdapter>[0];
}

export interface AdapterRegistration {
  readonly kind: ChannelKind;
  readonly platforms: readonly Platform[];
  readonly contentPolicy: PlatformContentPolicy;
  readonly supportsMetrics: boolean;
  create(options: AdapterResolverOptions): ChannelAdapter;
}

export class AdapterRegistry {
  private readonly registrations = new Map<string, AdapterRegistration>();

  constructor(registrations: readonly AdapterRegistration[] = []) {
    for (const registration of registrations) this.register(registration);
  }

  register(registration: AdapterRegistration) {
    const platforms = [...new Set(registration.platforms)];
    if (!platforms.length) throw new Error('适配器至少需要注册一个平台');
    for (const platform of platforms) {
      if (this.registrations.has(`${platform}:${registration.kind}`)) {
        throw new Error(`平台通道已注册：${platform}:${registration.kind}`);
      }
    }
    const saved = { ...registration, platforms };
    for (const platform of platforms) this.registrations.set(`${platform}:${registration.kind}`, saved);
  }

  has(platform: Platform, kind: ChannelKind) {
    return this.registrations.has(`${platform}:${kind}`);
  }

  registration(platform: Platform, kind: ChannelKind) {
    const registration = this.registrations.get(`${platform}:${kind}`);
    if (!registration) throw new ChannelNotConfiguredError(`平台 ${platform} 暂无${kind === 'official' ? '官方' : kind}通道实现`);
    return registration;
  }

  resolve(platform: Platform, kind: ChannelKind, options: AdapterResolverOptions = {}) {
    const channel = options.forceSandbox && kind !== 'manual' ? 'sandbox' : kind;
    const registration = this.registration(platform, channel);
    const adapter = registration.create(options);
    if (adapter.kind !== channel || !adapter.platforms.includes(platform)
      || registration.supportsMetrics !== Boolean(adapter.fetchMetrics)) {
      throw new ChannelNotConfiguredError(`平台 ${platform} 的 ${channel} 适配器与注册能力不一致`);
    }
    return adapter;
  }
}
