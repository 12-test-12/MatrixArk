export type BilibiliBrowserDraft = {
  taskId: string;
  kind: 'article' | 'video';
  title: string;
  body: string;
  tags: string[];
  summary?: string;
  imagePaths: string[];
  videoPath?: string;
};

export type BrowserDraftPrefillResult = {
  targetUrl: string;
  filled: string[];
  manualSteps: string[];
};

export type BrowserPublishedCapture = {
  taskId: string;
  detectedUrl: string;
  detectedId: string | null;
  detectedAt: string;
};

type LocatorLike = {
  first(): LocatorLike;
  waitFor(options?: { state?: 'attached' | 'visible'; timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  press(key: string, options?: { timeout?: number }): Promise<void>;
  setInputFiles(files: string | string[], options?: { timeout?: number }): Promise<void>;
};

type FrameLike = {
  locator?(selector: string): LocatorLike;
};

export type PrefillPageLike = {
  goto(url: string, options?: { waitUntil?: 'domcontentloaded' | 'load'; timeout?: number }): Promise<unknown>;
  locator?(selector: string): LocatorLike;
  frames?(): FrameLike[];
  waitForTimeout?(ms: number): Promise<void>;
};

export const BILIBILI_VIDEO_UPLOAD_URL = 'https://member.bilibili.com/platform/upload/video/frame';
export const BILIBILI_ARTICLE_EDIT_URL = 'https://member.bilibili.com/platform/upload/text/edit';

export function extractBilibiliPublishedWork(rawUrl: string): { detectedUrl: string; detectedId: string | null } | null {
  if (!URL.canParse(rawUrl)) return null;
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' || (parsed.hostname !== 'bilibili.com' && !parsed.hostname.endsWith('.bilibili.com'))) {
    return null;
  }

  const videoMatch = /^\/video\/(BV[0-9A-Za-z]{6,32}|av\d{1,16})\/?$/i.exec(parsed.pathname);
  if (videoMatch?.[1]) {
    const id = videoMatch[1];
    return { detectedUrl: `https://www.bilibili.com/video/${id}`, detectedId: id };
  }

  const articleMatch = /^\/read\/cv(\d{1,20})\/?$/i.exec(parsed.pathname);
  if (articleMatch?.[1]) {
    const id = articleMatch[1];
    return { detectedUrl: `https://www.bilibili.com/read/cv${id}`, detectedId: id };
  }

  const bvid = parsed.searchParams.get('bvid')?.trim();
  if (bvid && /^BV[0-9A-Za-z]{6,32}$/.test(bvid)) {
    return { detectedUrl: `https://www.bilibili.com/video/${bvid}`, detectedId: bvid };
  }
  const cvid = parsed.searchParams.get('cvid')?.trim();
  if (cvid && /^[1-9]\d{0,19}$/.test(cvid)) {
    return { detectedUrl: `https://www.bilibili.com/read/cv${cvid}`, detectedId: cvid };
  }
  const aid = parsed.searchParams.get('aid')?.trim();
  if (aid && /^[1-9]\d{0,19}$/.test(aid)) {
    return { detectedUrl: `https://www.bilibili.com/video/av${aid}`, detectedId: `av${aid}` };
  }
  return null;
}

async function findAttached(root: FrameLike, selectors: readonly string[], timeoutMs = 1_500): Promise<LocatorLike | null> {
  if (typeof root.locator !== 'function') return null;
  for (const selector of selectors) {
    try {
      const target = root.locator(selector).first();
      await target.waitFor({ state: 'attached', timeout: timeoutMs });
      return target;
    } catch {
      // Try next selector when Bilibili editor DOM differs across modes or updates.
    }
  }
  return null;
}

async function tryFill(roots: FrameLike[], selectors: readonly string[], value: string, timeoutMs = 1_500): Promise<boolean> {
  if (!value) return false;
  for (const root of roots) {
    const target = await findAttached(root, selectors, timeoutMs);
    if (!target) continue;
    try {
      await target.fill(value, { timeout: timeoutMs });
      return true;
    } catch {
      // Keep fallback intact if a particular element is readonly or detached.
    }
  }
  return false;
}

async function tryFillTags(roots: FrameLike[], selectors: readonly string[], tags: readonly string[]): Promise<boolean> {
  const clean = tags.map((tag) => tag.trim()).filter(Boolean).slice(0, 10);
  if (!clean.length) return false;
  for (const root of roots) {
    const target = await findAttached(root, selectors, 1_500);
    if (!target) continue;
    try {
      for (const tag of clean) {
        await target.fill(tag, { timeout: 1_000 });
        await target.press('Enter', { timeout: 1_000 });
      }
      return true;
    } catch {
      // Ignore partial tag input failure; operator can adjust tags before clicking publish.
    }
  }
  return false;
}

async function trySetFiles(roots: FrameLike[], selectors: readonly string[], files: string | string[], timeoutMs = 1_500): Promise<boolean> {
  if ((Array.isArray(files) && files.length === 0) || (!Array.isArray(files) && !files)) return false;
  for (const root of roots) {
    const target = await findAttached(root, selectors, timeoutMs);
    if (!target) continue;
    try {
      await target.setInputFiles(files, { timeout: timeoutMs });
      return true;
    } catch {
      // Ignore if file input rejects programmatic attachment.
    }
  }
  return false;
}

/**
 * 导航至 B 站创作中心对应投稿页，按最佳努力自动预填稿件字段与本地素材。
 * 绝不自动点击最终发布/提交按钮，也不绕过验证码或平台安全校验。
 */
export async function prefillBilibiliDraft(page: PrefillPageLike, draft: BilibiliBrowserDraft): Promise<BrowserDraftPrefillResult> {
  const targetUrl = draft.kind === 'video' ? BILIBILI_VIDEO_UPLOAD_URL : BILIBILI_ARTICLE_EDIT_URL;
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  const filled: string[] = [];
  const manualSteps: string[] = [];

  if (typeof page.locator !== 'function') {
    manualSteps.push('请在打开的投稿页面参考下方已审交接包完成填写并手动提交发布');
    return { targetUrl, filled, manualSteps };
  }

  const roots = (): FrameLike[] => [page, ...(typeof page.frames === 'function' ? page.frames() : [])];

  if (draft.kind === 'video') {
    if (draft.videoPath) {
      const uploaded = await trySetFiles(
        roots(),
        ['input[type="file"][accept*="mp4"]', 'input[type="file"][accept*="video"]', '.bcc-upload input[type="file"]', 'input[type="file"]'],
        draft.videoPath,
        3_500,
      );
      if (uploaded) {
        filled.push('视频文件（已加入上传队列）');
        await page.waitForTimeout?.(800);
      } else {
        manualSteps.push('未能自动选中视频上传框，请手动选择已下载的视频文件');
      }
    }

    const title = [...draft.title.trim()].slice(0, 80).join('');
    if (await tryFill(roots(), ['input[placeholder*="标题"]', 'input[placeholder*="清晰明了"]', '.video-title input', 'input[maxlength="80"]'], title)) {
      filled.push('视频标题');
    } else if (title) {
      manualSteps.push('请手动填写视频标题');
    }

    if (await tryFillTags(roots(), ['input[placeholder*="回车"]', 'input[placeholder*="标签"]', '.tag-input input'], draft.tags)) {
      filled.push('视频标签');
    } else if (draft.tags.length > 0) {
      manualSteps.push('请手动添加视频标签');
    }

    const desc = [...draft.body.trim()].slice(0, 2000).join('');
    if (await tryFill(roots(), ['div[contenteditable="true"][data-placeholder*="简介"]', 'textarea[placeholder*="简介"]', '.ql-editor[contenteditable="true"]'], desc)) {
      filled.push('视频简介');
    } else if (desc) {
      manualSteps.push('请手动粘贴视频简介');
    }

    if (draft.imagePaths[0]) {
      if (await trySetFiles(roots(), ['input[type="file"][accept*="image"]'], draft.imagePaths[0])) {
        filled.push('视频封面');
      } else {
        manualSteps.push('请手动上传视频封面图片');
      }
    }

    manualSteps.push('请在浏览器中确认分区、等待视频转码与预览无误后，手动点击「立即投稿」');
    return { targetUrl, filled, manualSteps };
  }

  const title = [...draft.title.trim()].slice(0, 40).join('');
  if (await tryFill(roots(), ['textarea[placeholder*="标题"]', 'input[placeholder*="标题"]', '.article-title textarea', '.article-title input'], title, 3_000)) {
    filled.push('专栏标题');
  } else if (title) {
    manualSteps.push('请手动填写专栏标题');
  }

  const body = draft.body.trim();
  if (await tryFill(roots(), ['.ql-editor[contenteditable="true"]', '.ProseMirror[contenteditable="true"]', '[contenteditable="true"]'], body)) {
    filled.push('专栏正文');
  } else if (body) {
    manualSteps.push('请手动粘贴专栏正文');
  }

  const summary = draft.summary?.trim() ?? '';
  if (summary) {
    if (await tryFill(roots(), ['textarea[placeholder*="摘要"]', 'input[placeholder*="摘要"]'], summary)) {
      filled.push('专栏摘要');
    } else {
      manualSteps.push('请手动补充专栏摘要');
    }
  }

  if (draft.imagePaths.length > 0) {
    if (await trySetFiles(roots(), ['input[type="file"][accept*="image"]'], draft.imagePaths[0]!)) {
      filled.push(draft.imagePaths.length > 1 ? '专栏首图（其余图片请按需插入）' : '专栏图片');
    } else {
      manualSteps.push('请在编辑器内上传本地图片（可从下方交接包下载）');
    }
  }

  manualSteps.push('请在浏览器中核对专栏分类与排版、处理可能出现的安全验证后，手动点击「提交文章」');
  return { targetUrl, filled, manualSteps };
}
