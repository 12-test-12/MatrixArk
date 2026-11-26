import { BadRequestException } from '@nestjs/common';
import { decryptPlatformSecret, encryptPlatformSecret, platformKeyId } from './platform-app';

export type AccountSecretKind = 'password' | 'cookie';

export function encryptAccountSecret(kind: AccountSecretKind, workspaceId: string, accountId: string, value: string) {
  return {
    ciphertext: encryptPlatformSecret([`account-${kind}`, workspaceId, accountId], value),
    keyId: platformKeyId,
  };
}

export function decryptAccountSecret(
  kind: AccountSecretKind,
  workspaceId: string,
  accountId: string,
  ciphertext: string | null,
  keyId: string | null,
) {
  if (!ciphertext || keyId !== platformKeyId) return undefined;
  try {
    return decryptPlatformSecret([`account-${kind}`, workspaceId, accountId], ciphertext);
  } catch {
    return undefined;
  }
}

export function maskLoginIdentifier(raw: string) {
  const value = raw.trim();
  if (!value) return '';
  const at = value.indexOf('@');
  if (at > 0) {
    const local = value.slice(0, at);
    const domain = value.slice(at);
    const prefix = Array.from(local).slice(0, 2).join('');
    return `${prefix}***${domain}`;
  }
  const chars = Array.from(value);
  if (/^\+?\d{7,15}$/.test(value)) {
    return `${chars.slice(0, 3).join('')}****${chars.slice(-4).join('')}`;
  }
  if (chars.length <= 2) return `${chars[0]}*`;
  if (chars.length <= 4) return `${chars[0]}**${chars.at(-1)}`;
  return `${chars.slice(0, 2).join('')}***${chars.slice(-2).join('')}`;
}

export function parseCookieHeader(rawInput: string) {
  const raw = rawInput.trim();
  if (!raw || raw.length > 32_768) {
    throw new BadRequestException('Cookie 内容不能为空且长度不能超过 32 KiB');
  }
  const entries: Record<string, string> = {};
  const put = (name: unknown, value: unknown) => {
    if (typeof name !== 'string' || typeof value !== 'string') return;
    const k = name.trim();
    const v = value.trim();
    if (!k || !v || /[\r\n\0;]/.test(k) || /[\r\n\0;]/.test(v)) return;
    entries[k] = v;
  };

  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === 'object') {
            const row = item as Record<string, unknown>;
            put(row.name ?? row.key, row.value);
          }
        }
      } else if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          put(k, typeof v === 'string' ? v : String(v ?? ''));
        }
      }
    } catch {
      throw new BadRequestException('JSON 格式的 Cookie 无法解析，请粘贴标准 Cookie 字符串或浏览器导出的 JSON');
    }
  } else {
    const cleaned = raw.replace(/^cookie\s*:\s*/i, '').replace(/[\r\n]+/g, '; ');
    for (const part of cleaned.split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      put(trimmed.slice(0, eq), trimmed.slice(eq + 1));
    }
  }

  const pairs = Object.entries(entries);
  if (!pairs.length) {
    throw new BadRequestException('未能识别有效的 Cookie 键值对，请检查格式（例如 key=value; ...）');
  }
  return {
    entries,
    header: pairs.map(([k, v]) => `${k}=${v}`).join('; '),
  };
}

export function validatePlatformCookie(platform: 'bilibili' | 'xiaohongshu', entries: Record<string, string>) {
  if (platform === 'bilibili') {
    if (!entries.SESSDATA) {
      throw new BadRequestException('B 站 Cookie 缺少关键登录凭证 SESSDATA，请确认已登录后再复制完整 Cookie');
    }
    return;
  }
  const xhsKeys = [
    'web_session',
    'a1',
    'customer-sso-sid',
    'galaxy_creator_session_id',
    'access-token-creator.xiaohongshu.com',
    'x-user-id-creator.xiaohongshu.com',
  ];
  if (!xhsKeys.some((key) => Boolean(entries[key]))) {
    throw new BadRequestException(
      '小红书 Cookie 缺少有效会话字段（需包含 web_session、a1 或创作平台登录凭证）',
    );
  }
}

export function cleanTags(input?: readonly string[] | null) {
  if (!input?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of input) {
    const tag = item.trim().slice(0, 24);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 12) break;
  }
  return out;
}
