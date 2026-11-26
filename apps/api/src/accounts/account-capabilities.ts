import type { ChannelAccount, ChannelKind, Platform } from '@prisma/client';
import { config } from '../config';
import { isUnverifiedBilibiliAccount, resolveBilibiliChannel } from './platforms/bilibili-account-policy';

interface PlatformAccountPolicy {
  resolveChannel(account: ChannelAccount, now: Date, trial: boolean): ChannelKind | undefined;
  readonly supportsMetrics: boolean;
}

const policies: Record<Platform, PlatformAccountPolicy> = {
  bilibili: { resolveChannel: resolveBilibiliChannel, supportsMetrics: true },
  xiaohongshu: {
    resolveChannel: (account) => account.channelKind === 'manual' && ['active', 'pending'].includes(account.authStatus)
      ? 'manual' : undefined,
    supportsMetrics: false,
  },
};

export function resolveAccountCapabilities(account: ChannelAccount, now: Date, trial = false) {
  const policy = policies[account.platform];
  const eligible = Boolean(account.externalId && account.authCheckedAt && !account.archivedAt
    && (!account.rateLimitedUntil || account.rateLimitedUntil <= now)
    && (!trial || (config.trialAvailable && account.channelKind !== 'official')));
  const channel = eligible ? policy.resolveChannel(account, now, trial) : undefined;
  const identityCheckedAt = trial || isUnverifiedBilibiliAccount(account) || account.accessMethod === 'password'
    ? null : account.authCheckedAt;
  return {
    channel,
    identityCheckedAt,
    identityVerified: !trial && account.channelKind !== 'sandbox' && Boolean(account.externalId && identityCheckedAt),
    availableForHandoff: channel === 'manual',
    availableForOfficial: channel === 'official' || channel === 'sandbox',
    availableForMetrics: channel === 'official' && policy.supportsMetrics,
  };
}
