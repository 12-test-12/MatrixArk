import type { ChannelAccount, ChannelKind, Platform } from '@prisma/client';
import { config } from '../config';
import { extractBilibiliUid, isUnverifiedBilibiliAccount, resolveBilibiliChannel } from './platforms/bilibili-account-policy';

export type CapabilityReasonCode =
  | 'missing_external_id'
  | 'auth_unverified'
  | 'rate_limited'
  | 'platform_policy'
  | 'trial_restricted';

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

export function derivePlatformUid(
  account: Pick<ChannelAccount, 'platform' | 'externalId' | 'profileUrl'>,
): string | null {
  if (account.platform === 'bilibili') {
    return extractBilibiliUid(account.externalId);
  }
  if (account.externalId && /^[0-9a-f]{24}$/i.test(account.externalId)) {
    return account.externalId;
  }
  if (account.profileUrl && URL.canParse(account.profileUrl)) {
    const match = /^\/user\/profile\/([0-9a-f]{24})\/?$/i.exec(new URL(account.profileUrl).pathname);
    if (match?.[1]) return match[1];
  }
  return null;
}

function resolveCapabilityReason(
  account: ChannelAccount,
  now: Date,
  trial: boolean,
): CapabilityReasonCode {
  if (!account.externalId) return 'missing_external_id';
  if (account.rateLimitedUntil && account.rateLimitedUntil > now) return 'rate_limited';
  if (trial && (!config.trialAvailable || account.channelKind === 'official')) return 'trial_restricted';
  if (account.channelKind === 'sandbox') return 'platform_policy';
  if (account.channelKind === 'official') {
    if (account.platform !== 'bilibili' || config.sandboxChannel) return 'platform_policy';
    return 'auth_unverified';
  }
  return 'auth_unverified';
}

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
    capabilityReason: channel ? null : resolveCapabilityReason(account, now, trial),
  };
}
