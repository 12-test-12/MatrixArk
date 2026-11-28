import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccountOnboardingService } from './account-onboarding.service';
import type { BilibiliBrowserDraft } from './bilibili-browser-prefill';
import { LocalBrowserProfiles } from './local-browser-profiles';
import { extractBilibiliUid } from './publish-account';

@Injectable()
export class BilibiliBrowserService {
  constructor(private readonly prisma: PrismaService,
    private readonly onboarding: AccountOnboardingService,
    private readonly profiles: LocalBrowserProfiles) {}

  private async account(workspaceId: string, id: string) {
    const account = await this.prisma.channelAccount.findFirst({ where: { id, workspaceId, platform: 'bilibili' } });
    if (!account) throw new NotFoundException('账号不存在');
    if (account.archivedAt) throw new ConflictException('请先恢复已归档账号，再打开浏览器');
    if (account.channelKind !== 'manual') {
      throw new ConflictException('本阶段仅支持为人工交接账号绑定浏览器；官方 OAuth 账号的身份关联将在后续开放');
    }
    return account;
  }

  async list(workspaceId: string) {
    return { enabled: this.profiles.enabled, sessions: await this.profiles.list(workspaceId) };
  }

  async openPublishing(
    workspaceId: string,
    accountId: string,
    draft?: BilibiliBrowserDraft,
    options?: { switchAccount?: boolean },
  ) {
    const account = await this.account(workspaceId, accountId);
    if (account.rateLimitedUntil && account.rateLimitedUntil > new Date()) throw new ConflictException('账号处于平台限流期，请等待限流结束');
    const uid = extractBilibiliUid(account.externalId);
    if (!uid || !account.authCheckedAt) throw new ConflictException('账号身份尚未核验');
    const session = await this.profiles.requireVerified(workspaceId, accountId, uid, { allowSwitch: options?.switchAccount });
    if (!session.opened) await this.profiles.open(workspaceId, accountId, uid, session.id, options);
    const checked = await this.profiles.check(workspaceId, session.id, async (identity, current) => {
      if (identity.uid !== uid || current.accountId !== accountId) throw new ConflictException('本地浏览器账号与任务账号不一致');
      await this.account(workspaceId, accountId);
      return accountId;
    }, !draft);
    if (checked.status !== 'verified') throw new ConflictException('登录已失效，请在浏览器中登录后到账号管理重新核验');
    if (!draft) {
      return { sessionId: session.id, message: '已核验 UID 并打开对应账号的创作中心，请使用已审交接包完成投稿，然后回填结果。' };
    }
    const prefill = await this.profiles.prepareDraft(workspaceId, session.id, draft);
    return {
      sessionId: session.id,
      ...prefill,
      message: prefill.filled.length
        ? `已核验 UID 并打开投稿页，已自动预填：${prefill.filled.join('、')}。请在浏览器中确认后手动点击发布。`
        : '已核验 UID 并打开投稿页，请对照交接包在浏览器中完成填写并手动点击发布。',
    };
  }

  getTaskStatus(workspaceId: string, taskId: string) {
    return this.profiles.getTaskStatus(workspaceId, taskId);
  }

  closeTaskBrowser(workspaceId: string, taskId?: string) {
    return this.profiles.closeTask(workspaceId, taskId);
  }

  async open(workspaceId: string, input: { accountId?: string; sessionId?: string }) {
    if (input.sessionId) {
      const session = await this.profiles.get(workspaceId, input.sessionId);
      if (session.accountId) await this.account(workspaceId, session.accountId);
      return this.profiles.open(workspaceId, session.accountId, session.expectedUid, session.id);
    }
    const account = input.accountId ? await this.account(workspaceId, input.accountId) : null;
    const existing = account ? (await this.profiles.list(workspaceId)).find((session) => session.accountId === account.id) : null;
    return this.profiles.open(workspaceId, account?.id ?? null, account ? extractBilibiliUid(account.externalId) : null, existing?.id);
  }

  check(workspaceId: string, userId: string, id: string) {
    return this.profiles.check(workspaceId, id, async (identity, session) => {
      if (session.accountId) await this.account(workspaceId, session.accountId);
      const existing = await this.prisma.channelAccount.findFirst({
        where: { workspaceId, platform: 'bilibili', externalId: { in: [
          `bili-web-uid:${identity.uid}`, `manual-bili-uid:${identity.uid}`,
        ] } },
      });
      const accountId = session.accountId ?? existing?.id;
      if (accountId && (await this.profiles.list(workspaceId)).some((other) => other.id !== id && other.accountId === accountId)) {
        throw new ConflictException('该账号已有独立浏览器会话，请关闭并删除当前未关联会话，打开原账号的浏览器');
      }
      return this.onboarding.connectBilibiliBrowserAccount(workspaceId, userId, identity, session.accountId ?? undefined);
    });
  }

  close(workspaceId: string, id: string) { return this.profiles.close(workspaceId, id); }
  remove(workspaceId: string, id: string) { return this.profiles.remove(workspaceId, id); }
}
