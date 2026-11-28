import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BadGatewayException, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { z } from 'zod';

import {
  extractBilibiliPublishedWork,
  prefillBilibiliDraft,
  type BilibiliBrowserDraft,
  type BrowserDraftPrefillResult,
  type BrowserPublishedCapture,
} from './bilibili-browser-prefill';

const uid = z.string().regex(/^[1-9]\d{0,19}$/);
const sessionSchema = z.object({
  id: z.string().uuid(), accountId: z.string().min(1).nullable(),
  expectedUid: uid.nullable(), verifiedUid: uid.nullable(),
  status: z.enum(['unverified', 'verified', 'expired', 'mismatch']),
  lastCheckedAt: z.string().datetime().nullable(),
});
export type LocalBrowserSession = z.infer<typeof sessionSchema>;
export type BrowserIdentity = { uid: string; name: string };
type Options = { enabled: boolean; root: string; channel: 'msedge' | 'chrome' };
type ActiveTaskState = {
  taskId: string;
  targetUrl: string;
  filled: string[];
  manualSteps: string[];
  capture?: BrowserPublishedCapture;
};
type ActiveBrowser = {
  workspaceId: string;
  id: string;
  context: BrowserContext;
  token: string;
  released?: Promise<void>;
  watchingCapture?: boolean;
  activeTask?: ActiveTaskState;
};
const samePath = (left: string, right: string) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);

// 会话记录与 Cookie 都留在本机；数据库仅保存现有账号身份。
export class LocalBrowserProfiles {
  private active?: ActiveBrowser;
  private operating = false;
  private releasing = Promise.resolve();

  constructor(private readonly options: Options) {}

  get enabled() { return this.options.enabled; }

  private async directory(workspaceId: string, id?: string, create = false) {
    if (id && !z.string().uuid().safeParse(id).success) throw new BadRequestException('本地会话 ID 无效');
    const root = resolve(this.options.root);
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    // 拒绝符号链接和目录联接，防止读写或删除落在配置目录之外。
    if (!samePath(await realpath(root), root)) throw new ConflictException('本地浏览器目录不能使用符号链接');
    const workspace = join(root, createHash('sha256').update(workspaceId).digest('hex'));
    const parts = id ? [workspace, join(workspace, id)] : [workspace];
    for (const path of parts) {
      if (create) await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      if ((await lstat(path)).isSymbolicLink() || !samePath(await realpath(path), path)) {
        throw new ConflictException('本地浏览器目录不安全');
      }
    }
    return parts[parts.length - 1]!;
  }

  async list(workspaceId: string) {
    if (!this.enabled) return [];
    let directory: string;
    try { directory = await this.directory(workspaceId); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const items: (LocalBrowserSession & { error?: string })[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !z.string().uuid().safeParse(entry.name).success) continue;
      try { items.push(await this.get(workspaceId, entry.name)); } catch (error) {
        if (!(error instanceof ConflictException || error instanceof NotFoundException)) throw error;
        items.push({ id: entry.name, accountId: null, expectedUid: null, verifiedUid: null,
          status: 'unverified', lastCheckedAt: null, error: '会话记录损坏，请关闭浏览器后删除此会话并重新登录' });
      }
    }
    return items.map((session) => ({ ...session,
      opened: this.active?.workspaceId === workspaceId && this.active.id === session.id }));
  }

  async get(workspaceId: string, id: string): Promise<LocalBrowserSession> {
    try {
      const directory = await this.directory(workspaceId, id);
      const session = sessionSchema.safeParse(JSON.parse(await readFile(join(directory, 'session.json'), 'utf8')));
      if (!session.success || session.data.id !== id) throw new ConflictException('本地会话记录损坏，请删除后重新登录');
      return session.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundException('本地会话不存在');
      if (error instanceof SyntaxError) throw new ConflictException('本地会话记录损坏，请删除后重新登录');
      throw error;
    }
  }

  private async save(workspaceId: string, session: LocalBrowserSession) {
    const directory = await this.directory(workspaceId, session.id, true);
    const temporary = join(directory, `session-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(session), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(directory, 'session.json'));
  }

  async requireVerified(workspaceId: string, accountId: string, expectedUid: string, options?: { allowSwitch?: boolean }) {
    if (!this.enabled) throw new ConflictException('本机未启用浏览器辅助，请在本地模式运行 MatrixArk');
    const session = (await this.list(workspaceId)).find((item) => item.accountId === accountId);
    if (!session || session.error) throw new ConflictException('该账号没有可用的本地浏览器 Profile，请先连接浏览器');
    if (session.status !== 'verified' || session.expectedUid !== expectedUid || session.verifiedUid !== expectedUid) {
      throw new ConflictException('本地浏览器登录尚未核验或已失效，请重新检查登录 UID');
    }
    if (this.active && (this.active.workspaceId !== workspaceId || (this.active.id !== session.id && !options?.allowSwitch))) {
      throw new ConflictException('本机有其他账号浏览器正在使用，请先关闭后再选择浏览器辅助');
    }
    const profile = join(await this.directory(workspaceId, session.id), 'profile');
    try {
      if (!(await lstat(profile)).isDirectory() || !samePath(await realpath(profile), profile)) throw new Error('unsafe_profile');
    } catch { throw new ConflictException('本地浏览器 Profile 不存在或目录不安全，请重新连接'); }
    return session;
  }

  private async operation<T>(run: () => Promise<T>): Promise<T> {
    if (!this.enabled) throw new ConflictException('本地浏览器未启用，请在运行 MatrixArk 的电脑上启用本地模式');
    if (this.operating) throw new ConflictException('浏览器操作正在进行，请稍后重试');
    this.operating = true;
    try { await this.releasing; return await run(); } finally { this.operating = false; }
  }

  private async acquireLock(): Promise<string> {
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const path = join(this.options.root, 'browser.lock');
    const token = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    try {
      const lock = await open(path, 'wx', 0o600);
      try { await lock.writeFile(token); } finally { await lock.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = await readFile(path, 'utf8');
      let pid: unknown;
      try { pid = JSON.parse(previous).pid; } catch { /* 未完成的锁不可自动接管。 */ }
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
        throw new ConflictException('本地浏览器锁异常，请确认所有 MatrixArk 浏览器已关闭后检查本地目录');
      }
      try { process.kill(pid, 0); } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code === 'ESRCH' && await readFile(path, 'utf8') === previous) {
          const recoveryPath = join(this.options.root, 'recovery.lock');
          const recovery = await open(recoveryPath, 'wx', 0o600).catch(() => {
            throw new ConflictException('正在恢复本地浏览器锁，请稍后重试');
          });
          try { if (await readFile(path, 'utf8') === previous) await unlink(path); }
          finally { await recovery.close(); await unlink(recoveryPath); }
          return this.acquireLock();
        }
      }
      throw new ConflictException('本机已有浏览器会话正在使用，请先关闭它再打开其他账号');
    }
    return token;
  }

  private async releaseLock(token: string) {
    const path = join(this.options.root, 'browser.lock');
    try { if (await readFile(path, 'utf8') === token) await unlink(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private release(active: ActiveBrowser) {
    // 浏览器主动退出与接口关闭可能同时触发，只释放一次，避免误删下一次打开的锁。
    if (!active.released) active.released = this.releaseLock(active.token);
    this.releasing = active.released;
    if (this.active === active) this.active = undefined;
    return active.released;
  }

  protected launch(directory: string) {
    return chromium.launchPersistentContext(directory, {
      channel: this.options.channel, headless: false, viewport: null,
      timeout: 20_000, acceptDownloads: false,
    });
  }

  private attachCaptureWatcher(active: ActiveBrowser) {
    if (active.watchingCapture) return;
    active.watchingCapture = true;
    const recordUrl = (rawUrl: string) => {
      if (!active.activeTask || !rawUrl) return;
      const found = extractBilibiliPublishedWork(rawUrl);
      if (!found) return;
      active.activeTask.capture = {
        taskId: active.activeTask.taskId,
        ...found,
        detectedAt: new Date().toISOString(),
      };
    };
    const watchPage = (page: Page) => {
      if (typeof page.url === 'function') recordUrl(page.url());
      if (typeof page.on !== 'function') return;
      page.on('framenavigated', (frame) => {
        const mainFrame = typeof page.mainFrame === 'function' ? page.mainFrame() : undefined;
        if (mainFrame && frame !== mainFrame) return;
        const frameUrl = typeof frame?.url === 'function'
          ? frame.url()
          : (typeof page.url === 'function' ? page.url() : '');
        recordUrl(frameUrl);
      });
    };
    if (typeof active.context.pages === 'function') {
      for (const page of active.context.pages()) watchPage(page);
    }
    if (typeof active.context.on === 'function') {
      active.context.on('page', (page) => watchPage(page));
    }
  }

  async open(workspaceId: string, accountId: string | null, expectedUid: string | null, id?: string,
    options?: { switchAccount?: boolean }) {
    return this.operation(async () => {
      if (this.active) {
        if (options?.switchAccount && this.active.workspaceId === workspaceId) {
          const previous = this.active;
          await previous.context.close().catch(() => undefined);
          await this.release(previous);
        } else {
          throw new ConflictException('本机已有浏览器会话正在使用，请先关闭它再打开其他账号');
        }
      }
      const session: LocalBrowserSession = id ? await this.get(workspaceId, id) : {
        id: randomUUID(), accountId, expectedUid, verifiedUid: null, status: 'unverified', lastCheckedAt: null,
      };
      await this.directory(workspaceId, undefined, true);
      const token = await this.acquireLock();
      let context: BrowserContext | undefined;
      let active: ActiveBrowser | undefined;
      try {
        const directory = await this.directory(workspaceId, session.id, true);
        const profile = join(directory, 'profile');
        await mkdir(profile, { recursive: true, mode: 0o700 });
        if (!samePath(await realpath(profile), profile)) throw new ConflictException('本地 Profile 目录不安全');
        await this.save(workspaceId, session);
        context = await this.launch(profile);
        active = { workspaceId, id: session.id, context, token };
        const launched = active;
        this.active = active;
        context.on('close', () => {
          void this.release(launched).catch(() => undefined);
        });
        const page = context.pages()[0] ?? await context.newPage();
        await page.goto('https://passport.bilibili.com/login', { waitUntil: 'domcontentloaded', timeout: 15_000 });
        return { ...session, opened: true };
      } catch (error) {
        if (context) await context.close().catch(() => undefined);
        if (active) await this.release(active);
        else await this.releaseLock(token);
        if (error instanceof ConflictException) throw error;
        throw new BadGatewayException('无法打开 B 站登录浏览器，请确认本机已安装所选 Edge / Chrome，并检查网络后重试');
      }
    });
  }

  async check(workspaceId: string, id: string,
    connect: (identity: BrowserIdentity, session: LocalBrowserSession) => Promise<string>, openCreator = false) {
    return this.operation(async () => {
      const session = await this.get(workspaceId, id);
      const active = this.active;
      if (!active || active.workspaceId !== workspaceId || active.id !== id) {
        throw new ConflictException('请先打开该账号的浏览器，再检查登录');
      }
      session.lastCheckedAt = new Date().toISOString();
      session.status = 'unverified';
      session.verifiedUid = null;
      let response;
      try {
        response = await active.context.request.get('https://api.bilibili.com/x/web-interface/nav', {
          timeout: 10_000, maxRedirects: 0,
        });
        const data = z.object({ code: z.number(), data: z.object({ isLogin: z.boolean().optional(),
          mid: z.unknown(), uname: z.unknown(),
        }).nullish() }).safeParse(await response.json());
        if (!response.ok() || !data.success) throw new Error('invalid_response');
        if (data.data.code === -101 || (data.data.code === 0 && !data.data.data?.isLogin)) {
          session.status = 'expired';
          await this.save(workspaceId, session);
          return { ...session, opened: true };
        }
        if (data.data.code !== 0 || !data.data.data) throw new Error('upstream_error');
        const verified = z.object({ mid: z.union([uid, z.number().int().positive().safe()]),
          uname: z.string().trim().min(1).max(200) }).parse(data.data.data);
        const identity = { uid: String(verified.mid), name: verified.uname };
        if (session.expectedUid && session.expectedUid !== identity.uid) {
          session.status = 'mismatch';
          await this.save(workspaceId, session);
          throw new ConflictException(`登录 UID ${identity.uid} 与账号 UID ${session.expectedUid} 不一致，请在浏览器中切换回原账号`);
        }
        session.accountId = await connect(identity, session);
        session.expectedUid = identity.uid;
        session.verifiedUid = identity.uid;
        session.status = 'verified';
        await this.save(workspaceId, session);
        if (openCreator) {
          const page = active.context.pages()[0] ?? await active.context.newPage();
          await page.goto('https://member.bilibili.com/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
        }
        return { ...session, opened: true };
      } catch (error) {
        await this.save(workspaceId, session);
        if (error instanceof ConflictException || error instanceof NotFoundException) throw error;
        throw new BadGatewayException('暂时无法核验 B 站登录，请完成扫码和安全验证后重试');
      } finally { await response?.dispose().catch(() => undefined); }
    });
  }

  async prepareDraft(workspaceId: string, id: string, draft: BilibiliBrowserDraft): Promise<BrowserDraftPrefillResult> {
    return this.operation(async () => {
      const active = this.active;
      if (!active || active.workspaceId !== workspaceId || active.id !== id) {
        throw new ConflictException('请先打开该账号的浏览器，再准备投稿内容');
      }
      active.activeTask = { taskId: draft.taskId, targetUrl: '', filled: [], manualSteps: [] };
      this.attachCaptureWatcher(active);
      const page = active.context.pages()[0] ?? await active.context.newPage();
      const result = await prefillBilibiliDraft(page, draft);
      active.activeTask.targetUrl = result.targetUrl;
      active.activeTask.filled = result.filled;
      active.activeTask.manualSteps = result.manualSteps;
      return result;
    });
  }

  getTaskStatus(workspaceId: string, taskId: string) {
    const active = this.active?.workspaceId === workspaceId ? this.active : undefined;
    const matched = active?.activeTask?.taskId === taskId ? active.activeTask : undefined;
    return {
      enabled: this.enabled,
      opened: Boolean(active),
      activeForTask: Boolean(matched),
      sessionId: active?.id ?? null,
      targetUrl: matched?.targetUrl ?? null,
      filled: matched?.filled ?? [],
      manualSteps: matched?.manualSteps ?? [],
      capture: matched?.capture ?? null,
    };
  }

  async closeTask(workspaceId: string, taskId?: string) {
    return this.operation(async () => {
      const active = this.active;
      if (active && active.workspaceId === workspaceId && (!taskId || !active.activeTask || active.activeTask.taskId === taskId)) {
        await active.context.close().catch(() => undefined);
        await this.release(active);
        return { closed: true };
      }
      return { closed: false };
    });
  }

  async close(workspaceId: string, id: string) {
    return this.operation(async () => {
      const active = this.active;
      if (active?.workspaceId === workspaceId && active.id === id) {
        await active.context.close();
        await this.release(active);
        return { id, opened: false };
      }
      const session = await this.get(workspaceId, id);
      return { ...session, opened: false };
    });
  }

  async remove(workspaceId: string, id: string) {
    return this.operation(async () => {
      let directory: string;
      try { directory = await this.directory(workspaceId, id); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundException('本地会话不存在');
        throw error;
      }
      if (this.active) throw new ConflictException('请先关闭本机浏览器，再删除会话');
      const token = await this.acquireLock();
      try {
        await rm(directory, { recursive: true, force: false });
      } finally { await this.releaseLock(token); }
      return { ok: true };
    });
  }

  async onModuleDestroy() {
    const active = this.active;
    if (active) {
      await active.context.close();
      await this.release(active);
    }
    await this.releasing;
  }
}
