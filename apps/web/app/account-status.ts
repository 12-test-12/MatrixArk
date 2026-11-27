import type { Account, AccountAccessMethod, AccountAuthStatus, CapabilityReasonCode } from './api';

export type StatusTone = 'green' | 'amber' | 'red' | 'gray' | 'violet' | 'sky';
export type StatusCategory = 'ok' | 'unconfigured' | 'unknown' | 'unverified' | 'expired' | 'failed';

export type HealthCheckDiagnostics = {
  loginState: string;
  cookieState: 'none' | 'valid' | 'expiring' | 'expired';
  egressIp: string | null;
  egressIpCollision: boolean;
  siblingCollisions: number;
  profileLabel: string | null;
  readWriteSeparated: boolean;
  cookieExpiresAt: string | null;
  checkedAt: string;
};

export type StatusDimension = {
  label: string;
  shortLabel: string;
  tone: StatusTone;
  category: StatusCategory;
  detail: string;
};

export type AccountStatusView = {
  registration: StatusDimension;
  identity: StatusDimension;
  session: StatusDimension;
  capability: StatusDimension & {
    channelText: string;
    canExecute: string[];
    missingConfig: string[];
    unavailableReason: string | null;
  };
  riskEnv: StatusDimension & {
    riskLabel: string;
    riskTone: StatusTone;
    envLabel: string;
    envTone: StatusTone;
    coverage: string;
    checkedAt: string | null;
  };
  summaryHint: string;
};

export const accessMethodLabels: Record<AccountAccessMethod, string> = {
  manual_uid: 'UID 登记',
  qr_login: '扫码接入',
  password: '账号密码',
  cookie: 'Cookie 接入',
  oauth: '官方 OAuth',
  sandbox: '沙箱演示',
};

export const capabilityReasonLabels: Record<CapabilityReasonCode, string> = {
  missing_external_id: '未登记平台 UID',
  auth_unverified: '待核验或授权未生效',
  rate_limited: '平台限流冷却中',
  platform_policy: '平台不支持该能力',
  trial_restricted: '试用工作室限制',
};

export const authStatusLabels: Record<AccountAuthStatus, string> = {
  pending: '待授权',
  active: '授权有效',
  expired: '授权已过期',
  revoked: '授权已撤销',
};

export const statusCategoryLabels: Record<StatusCategory, string> = {
  ok: '正常就绪',
  unconfigured: '未配置',
  unknown: '未知',
  unverified: '未验证',
  expired: '已失效',
  failed: '实际失败',
};

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(value));
}

function buildRegistrationStatus(account: Account): StatusDimension {
  const hasBasicProfile = Boolean(
    account.platformUid || account.profileUrl || account.loginIdentifier || account.hasCredentials || account.hasCookie || account.hasPassword,
  );
  if (hasBasicProfile) {
    return {
      label: '已登记',
      shortLabel: '已登记',
      tone: 'green',
      category: 'ok',
      detail: '账号已加入 MatrixArk，已登记基础标识或接入凭据。',
    };
  }
  return {
    label: '已登记（资料待补全）',
    shortLabel: '资料待补',
    tone: 'gray',
    category: 'unconfigured',
    detail: '账号已加入 MatrixArk，但缺少平台 UID、主页链接等基础资料。',
  };
}

function buildIdentityStatus(account: Account, archived: boolean): StatusDimension {
  if (archived) {
    return {
      label: '已归档',
      shortLabel: '已归档',
      tone: 'gray',
      category: 'unknown',
      detail: '账号已归档，当前不参与平台核验与发布排期。',
    };
  }
  if (account.channelKind === 'sandbox') {
    return {
      label: '未知（沙箱演示）',
      shortLabel: '沙箱免核验',
      tone: 'gray',
      category: 'unknown',
      detail: '沙箱演示账号不触发真实平台身份核验。',
    };
  }
  if (account.identityVerified) {
    return {
      label: '已核验',
      shortLabel: '已核验',
      tone: 'green',
      category: 'ok',
      detail: account.identityCheckedAt ? `已完成平台身份核验（${formatDateTime(account.identityCheckedAt)}）。` : '已完成平台身份核验。',
    };
  }
  if (account.accessMethod === 'password') {
    return {
      label: '待核验',
      shortLabel: '待核验',
      tone: 'amber',
      category: 'unverified',
      detail: '账号密码托管方式仅加密保存登录凭据，尚未完成在线平台身份核验。',
    };
  }
  return {
    label: '待核验',
    shortLabel: '待核验',
    tone: 'amber',
    category: 'unverified',
    detail: '尚未完成平台身份核验，请通过扫码、Cookie 或官方授权核验身份。',
  };
}

function buildSessionStatus(account: Account, nowMs: number, diag?: HealthCheckDiagnostics): StatusDimension {
  const authExpMs = account.authExpiresAt ? new Date(account.authExpiresAt).getTime() : null;
  const cookieExpMs = account.cookieExpiresAt ? new Date(account.cookieExpiresAt).getTime() : null;

  if (account.channelKind === 'sandbox') {
    return {
      label: '沙箱模拟会话',
      shortLabel: '沙箱会话',
      tone: 'violet',
      category: 'ok',
      detail: '沙箱模拟通道无需真实平台登录态。',
    };
  }
  if (account.channelKind === 'official') {
    if (account.authStatus === 'revoked') {
      return { label: '授权已撤销', shortLabel: '已撤销', tone: 'red', category: 'expired', detail: '开放平台授权已被撤销，请重新授权。' };
    }
    if (account.authStatus === 'expired' || (authExpMs !== null && authExpMs <= nowMs)) {
      return {
        label: '官方授权已过期',
        shortLabel: '授权过期',
        tone: 'red',
        category: 'expired',
        detail: account.authExpiresAt ? `开放平台授权已于 ${formatDateTime(account.authExpiresAt)} 到期，请重新授权。` : '开放平台授权已过期。',
      };
    }
    if (account.authStatus === 'active' && account.hasCredentials) {
      return {
        label: '已获得官方授权',
        shortLabel: '官方授权',
        tone: 'green',
        category: 'ok',
        detail: account.authExpiresAt ? `开放平台授权有效至 ${formatDateTime(account.authExpiresAt)}。` : '已绑定开放平台有效授权。',
      };
    }
    return {
      label: '官方授权缺失',
      shortLabel: '缺授权',
      tone: 'amber',
      category: 'unconfigured',
      detail: '尚未完成开放平台 OAuth 授权或缺少有效访问令牌。',
    };
  }

  if (account.hasCookie) {
    if (diag?.loginState === 'invalid') {
      return {
        label: '在线会话已失效',
        shortLabel: '会话失效',
        tone: 'red',
        category: 'expired',
        detail: '最近联网体检探测到 Cookie 登录态已失效，请重新扫码或导入 Cookie。',
      };
    }
    if (diag?.cookieState === 'expired' || (cookieExpMs !== null && cookieExpMs <= nowMs)) {
      return {
        label: 'Cookie 已过期',
        shortLabel: 'Cookie过期',
        tone: 'red',
        category: 'expired',
        detail: account.cookieExpiresAt ? `标注的 Cookie 有效期已于 ${formatDateTime(account.cookieExpiresAt)} 到期。` : 'Cookie 已过期。',
      };
    }
    if (diag?.loginState === 'probe_error') {
      return {
        label: '在线验证失败',
        shortLabel: '验证失败',
        tone: 'amber',
        category: 'failed',
        detail: '最近联网验证平台接口超时或返回异常，无法确认登录态是否有效。',
      };
    }
    if (diag?.cookieState === 'expiring' || (cookieExpMs !== null && cookieExpMs - nowMs <= 72 * 3_600_000)) {
      return {
        label: 'Cookie 即将到期',
        shortLabel: '即将到期',
        tone: 'amber',
        category: 'ok',
        detail: account.cookieExpiresAt ? `Cookie 将于 ${formatDateTime(account.cookieExpiresAt)} 到期，建议提前续期。` : 'Cookie 使用时间较长，建议提前更新。',
      };
    }
    const checkedAt = diag?.checkedAt ?? account.envCheckedAt;
    if (checkedAt && account.platform === 'bilibili' && account.authStatus === 'active') {
      return {
        label: '在线会话已验证',
        shortLabel: '会话已验',
        tone: 'green',
        category: 'ok',
        detail: `已通过 B 站接口验证在线登录态（${formatDateTime(checkedAt)}）${cookieExpMs === null ? '，Cookie 到期日未标注' : ''}。`,
      };
    }
    if (checkedAt && account.platform === 'xiaohongshu') {
      return {
        label: '已保存 Cookie（未联网验证）',
        shortLabel: '未联网验证',
        tone: 'sky',
        category: 'unverified',
        detail: '已保存 Cookie 且会话字段齐全，但平台未提供联网登录态验证接口。',
      };
    }
    return {
      label: cookieExpMs === null ? '已保存 Cookie（有效期未知）' : '已保存 Cookie（未验证）',
      shortLabel: '未验证会话',
      tone: 'gray',
      category: cookieExpMs === null ? 'unknown' : 'unverified',
      detail: '仅保存了 Cookie 凭据，尚未执行环境体检确认在线登录态，不能推断登录一定有效。',
    };
  }

  if (account.hasPassword) {
    return {
      label: '已保存账号密码（未验证）',
      shortLabel: '仅存密码',
      tone: 'gray',
      category: 'unverified',
      detail: '仅在服务端加密保存账号密码，不代表在线会话有效。',
    };
  }

  return {
    label: '未配置登录凭据',
    shortLabel: '未配置凭据',
    tone: 'gray',
    category: 'unconfigured',
    detail: '未保存账号密码、Cookie 或官方授权令牌。',
  };
}

function buildCapabilityStatus(account: Account, archived: boolean): AccountStatusView['capability'] {
  if (archived) {
    return {
      label: '已归档',
      shortLabel: '已归档',
      tone: 'gray',
      category: 'unknown',
      detail: '账号已归档，恢复后方可参与发布排期。',
      channelText: '无（已归档）',
      canExecute: [],
      missingConfig: ['需先在归档列表中恢复账号'],
      unavailableReason: null,
    };
  }
  if (account.channelKind === 'sandbox' && account.availableForOfficial) {
    return {
      label: '沙箱演示',
      shortLabel: '沙箱演示',
      tone: 'violet',
      category: 'ok',
      detail: '仅在试用/沙箱环境中模拟投稿与回读，不会真实发布到外网平台。',
      channelText: '沙箱通道（sandbox）',
      canExecute: ['模拟自动投稿', '模拟发布回执'],
      missingConfig: ['真实平台发布能力（沙箱账号不连接外网）'],
      unavailableReason: null,
    };
  }
  if (account.availableForOfficial) {
    const canExecute = ['官方自动投稿'];
    const missingConfig: string[] = [];
    if (account.availableForMetrics) canExecute.push('自动同步作品成效');
    else missingConfig.push('当前通道不支持自动读取成效');
    return {
      label: '官方自动投稿',
      shortLabel: '官方投稿',
      tone: 'green',
      category: 'ok',
      detail: account.availableForMetrics
        ? '已具备官方自动投稿与成效读取能力。'
        : '已具备官方自动投稿能力（暂不支持自动成效读取）。',
      channelText: '官方接口通道（official）',
      canExecute,
      missingConfig,
      unavailableReason: null,
    };
  }
  if (account.availableForHandoff) {
    return {
      label: '支持人工交接',
      shortLabel: '人工交接',
      tone: 'sky',
      category: 'ok',
      detail: '支持生成人工交接待办与内容包，但不具备官方自动投稿能力。',
      channelText: '人工交接通道（manual）',
      canExecute: ['生成发布交接待办', '人工回填作品链接与成效'],
      missingConfig: [
        account.platform === 'bilibili'
          ? '未接入 B 站开放平台 OAuth，不支持自动投稿与自动成效回读'
          : '小红书平台暂不支持官方自动投稿，仅走人工交接',
      ],
      unavailableReason: null,
    };
  }
  const reasonText = account.capabilityReason ? capabilityReasonLabels[account.capabilityReason] : '未满足平台能力策略';
  return {
    label: '当前无法排期',
    shortLabel: '无法排期',
    tone: 'amber',
    category: account.capabilityReason === 'missing_external_id' ? 'unconfigured' : 'unverified',
    detail: `当前不可排期发布：${reasonText}。`,
    channelText: '无可用发布通道',
    canExecute: [],
    missingConfig: [reasonText],
    unavailableReason: reasonText,
  };
}

function buildRiskEnvStatus(account: Account, archived: boolean, nowMs: number, diag?: HealthCheckDiagnostics): AccountStatusView['riskEnv'] {
  const checkedAt = diag?.checkedAt ?? account.envCheckedAt ?? null;
  const cookieExpMs = account.cookieExpiresAt ? new Date(account.cookieExpiresAt).getTime() : null;
  const coverage = account.channelKind === 'official'
    ? '开放平台授权有效期与出口 IP 冲突检查'
    : account.hasCookie && account.platform === 'bilibili'
      ? '联网探测 B 站登录态、Cookie 有效期、只读会话与出口 IP 冲突'
      : account.hasCookie
        ? 'Cookie 会话字段完整性、只读会话与出口 IP 冲突（不联网验证登录态）'
        : '出口 IP 冲突与人工风险标记检查（未配置 Cookie，不验证在线登录态）';

  const riskLabel = account.riskStatus === 'risk'
    ? '风险异常'
    : account.riskStatus === 'warning'
      ? '预警提醒'
      : '暂无风险记录';
  const riskTone: StatusTone = account.riskStatus === 'risk' ? 'red' : account.riskStatus === 'warning' ? 'amber' : 'gray';

  let envLabel = '未体检';
  let envTone: StatusTone = 'gray';
  let category: StatusCategory = 'unverified';
  let detail = '尚未执行环境体检，尚无环境与登录态检测结果；暂无风险记录不代表所有功能健康。';

  if (archived) {
    envLabel = '已归档';
    category = 'unknown';
    detail = '账号已归档，不参与定期环境巡检。';
  } else if (diag?.loginState === 'probe_error') {
    envLabel = '体检失败';
    envTone = 'amber';
    category = 'failed';
    detail = '最近一次联网环境体检失败（网络或平台接口异常），请稍后重新体检。';
  } else if (!checkedAt) {
    envLabel = '未体检';
    envTone = 'gray';
    category = 'unverified';
  } else if (diag?.cookieState === 'expired' || (cookieExpMs !== null && cookieExpMs <= nowMs)) {
    envLabel = 'Cookie 已过期';
    envTone = 'red';
    category = 'expired';
    detail = `最近体检于 ${formatDateTime(checkedAt)}；Cookie 已过期，请及时续期。`;
  } else if (diag?.cookieState === 'expiring' || (cookieExpMs !== null && cookieExpMs - nowMs <= 72 * 3_600_000)) {
    envLabel = '即将到期';
    envTone = 'amber';
    category = 'ok';
    detail = `最近体检于 ${formatDateTime(checkedAt)}；Cookie 即将到期，建议提前更新。`;
  } else if (cookieExpMs !== null) {
    const days = Math.max(1, Math.ceil((cookieExpMs - nowMs) / 86_400_000));
    envLabel = `有效 (${days}天)`;
    envTone = 'green';
    category = 'ok';
    detail = `最近体检于 ${formatDateTime(checkedAt)}；覆盖范围：${coverage}。`;
  } else {
    envLabel = '已体检';
    envTone = 'green';
    category = 'ok';
    detail = `最近体检于 ${formatDateTime(checkedAt)}；覆盖范围：${coverage}。`;
  }

  if (account.riskStatus === 'risk' || account.riskStatus === 'warning') {
    category = 'failed';
    detail = account.riskReason ? `${riskLabel}：${account.riskReason}` : `当前账号存在未解除的${riskLabel}。`;
  }

  return {
    label: account.riskStatus === 'risk' || account.riskStatus === 'warning' ? riskLabel : checkedAt ? `已体检 · ${riskLabel}` : '尚无检测结果',
    shortLabel: riskLabel,
    tone: account.riskStatus === 'risk' || account.riskStatus === 'warning' ? riskTone : envTone,
    category,
    detail,
    riskLabel,
    riskTone,
    envLabel,
    envTone,
    coverage,
    checkedAt,
  };
}

export function buildAccountStatusView(
  account: Account,
  archived: boolean,
  diag?: HealthCheckDiagnostics,
  now = new Date(),
): AccountStatusView {
  const nowMs = now.getTime();
  const registration = buildRegistrationStatus(account);
  const identity = buildIdentityStatus(account, archived);
  const session = buildSessionStatus(account, nowMs, diag);
  const capability = buildCapabilityStatus(account, archived);
  const riskEnv = buildRiskEnvStatus(account, archived, nowMs, diag);

  let summaryHint: string;
  if (archived) {
    summaryHint = '此账号已归档，当前不参与发布排期与环境巡检。';
  } else if (account.channelKind === 'sandbox') {
    summaryHint = '此账号为沙箱演示账号，仅用于模拟投稿与状态演练，不触达真实平台。';
  } else if (account.riskStatus === 'risk' || account.riskStatus === 'warning') {
    summaryHint = `此账号当前存在${riskEnv.riskLabel}${account.riskReason ? `（${account.riskReason}）` : ''}，建议先核查环境与风险事件。`;
  } else if (account.availableForOfficial) {
    summaryHint = `此账号已登记并获得官方授权，支持官方自动投稿${account.availableForMetrics ? '与成效读取' : ''}；${riskEnv.checkedAt ? '最近环境体检暂无告警。' : '尚未执行环境体检。'}`;
  } else if (account.availableForHandoff) {
    summaryHint = account.identityVerified
      ? `此账号已完成身份核验，当前支持人工交接（不具备自动投稿能力）；${riskEnv.checkedAt ? '最近环境体检暂无告警。' : '尚未执行环境体检。'}`
      : '此账号已登记，目前支持人工交接，但尚未完成在线身份验证。';
  } else {
    summaryHint = `此账号已登记，当前无法排期（${capability.unavailableReason ?? '未满足平台能力策略'}）。`;
  }

  return { registration, identity, session, capability, riskEnv, summaryHint };
}
