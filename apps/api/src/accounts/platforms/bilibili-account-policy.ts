import type { ChannelAccount } from '@prisma/client';
import { config } from '../../config';
import { platformKeyId } from '../platform-app';

export const biliKeyId = 'bilibili-v1';

export const bilibiliManualUidPrefix = 'manual-bili-uid:';

export const bilibiliWebUidPrefix = 'bili-web-uid:';

export function extractBilibiliUid(externalId?: string | null) {
  if (!externalId) return null;
  for (const prefix of [bilibiliManualUidPrefix, bilibiliWebUidPrefix]) {
    if (externalId.startsWith(prefix)) {
      const uid = externalId.slice(prefix.length);
      if (/^[1-9][0-9]{0,19}$/.test(uid)) return uid;
    }
  }
  return null;
}

export function isUnverifiedBilibiliAccount(
  account: Pick<ChannelAccount, 'platform' | 'channelKind' | 'externalId' | 'accessMethod'>,
) {
  return account.platform === 'bilibili' && account.channelKind === 'manual'
    && (account.accessMethod === 'manual_uid' || Boolean(account.externalId?.startsWith(bilibiliManualUidPrefix)));
}

export function bilibiliManualProfile(account: Pick<ChannelAccount, 'platform' | 'channelKind' | 'externalId'>) {
  if (account.platform !== 'bilibili' || account.channelKind !== 'manual') return null;
  const uid = extractBilibiliUid(account.externalId);
  return uid ? `https://space.bilibili.com/${uid}` : null;
}

export function resolveBilibiliChannel(account: ChannelAccount, now: Date, trial = false) {
  if (account.channelKind === 'manual') {
    if (isUnverifiedBilibiliAccount(account)) return undefined;
    return ['active', 'pending'].includes(account.authStatus) ? 'manual' : undefined;
  }
  if (account.platform !== 'bilibili' || account.authStatus !== 'active') return undefined;
  if (account.channelKind === 'sandbox') return trial || config.sandboxChannel ? 'sandbox' : undefined;
  const enabled = account.credentialsKeyId === platformKeyId ? !config.sandboxChannel
    : config.bilibili.enabled && account.credentialsKeyId === biliKeyId;
  if (enabled && account.authExpiresAt && account.authExpiresAt > now
    && account.authScope.includes('ATC_BASE') && account.authScope.includes('ATC_DATA')
    && account.credentialsCiphertext) return 'official';
  return undefined;
}
