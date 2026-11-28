import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';

process.env.BILIBILI_CREDENTIALS_KEY = 'a'.repeat(64);
process.env.SESSION_SECRET = 'b'.repeat(64);

const { AccountOnboardingService, extractCookiesFromResponse } = await import('../dist/accounts/account-onboarding.service.js');

function createInMemoryPrisma(options = {}) {
  const tickets = new Map();
  const accounts = new Map();
  let failNextAccountWrite = Boolean(options.failAccountWrite);

  const matchTicket = (row, where = {}) => {
    if (!row) return false;
    if (where.id && row.id !== where.id) return false;
    if (where.workspaceId && row.workspaceId !== where.workspaceId) return false;
    if (where.userId && row.userId !== where.userId) return false;
    if (where.state?.in && !where.state.in.includes(row.state)) return false;
    if (where.expiresAt?.gt && !(row.expiresAt > where.expiresAt.gt)) return false;
    if (where.expiresAt?.lte && !(row.expiresAt <= where.expiresAt.lte)) return false;
    if (where.updatedAt?.lte && !(row.updatedAt <= where.updatedAt.lte)) return false;
    if (where.OR) {
      const ok = where.OR.some((clause) => {
        if ('lockedUntil' in clause) {
          if (clause.lockedUntil === null) return row.lockedUntil === null;
          if (clause.lockedUntil?.lte) return row.lockedUntil !== null && row.lockedUntil <= clause.lockedUntil.lte;
        }
        return matchTicket(row, clause);
      });
      if (!ok) return false;
    }
    return true;
  };

  const applyTicketData = (row, data) => {
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) row[k] = v;
    }
    row.updatedAt = new Date();
  };

  const prisma = {
    _tickets: tickets,
    _accounts: accounts,
    setFailAccountWrite(val) {
      failNextAccountWrite = val;
    },
    bilibiliQrTicket: {
      async deleteMany({ where } = {}) {
        let count = 0;
        for (const [id, row] of tickets.entries()) {
          if (matchTicket(row, where)) {
            tickets.delete(id);
            count += 1;
          }
        }
        return { count };
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const row of tickets.values()) {
          if (matchTicket(row, where)) {
            applyTicketData(row, data);
            count += 1;
          }
        }
        return { count };
      },
      async create({ data }) {
        const now = new Date();
        const row = {
          id: data.id ?? randomUUID(),
          workspaceId: data.workspaceId,
          userId: data.userId,
          groupId: data.groupId ?? null,
          verificationUrl: data.verificationUrl,
          qrcodeKeyCiphertext: data.qrcodeKeyCiphertext ?? null,
          qrcodeKeyKeyId: data.qrcodeKeyKeyId ?? null,
          tempCookieCiphertext: data.tempCookieCiphertext ?? null,
          tempCookieKeyId: data.tempCookieKeyId ?? null,
          tempMid: data.tempMid ?? null,
          tempUname: data.tempUname ?? null,
          state: data.state,
          lastBiliCode: data.lastBiliCode ?? null,
          lastError: data.lastError ?? null,
          accountId: data.accountId ?? null,
          expiresAt: data.expiresAt,
          nextPollAt: data.nextPollAt,
          lockedUntil: data.lockedUntil ?? null,
          createdAt: now,
          updatedAt: now,
        };
        tickets.set(row.id, row);
        return { ...row };
      },
      async findFirst({ where, orderBy } = {}) {
        let matched = [...tickets.values()].filter((row) => matchTicket(row, where));
        if (orderBy?.some((o) => o.createdAt === 'desc')) {
          matched.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        return matched[0] ? { ...matched[0] } : null;
      },
      async update({ where, data }) {
        const row = tickets.get(where.id);
        if (!row) throw new Error('Ticket not found');
        applyTicketData(row, data);
        return { ...row };
      },
    },
    channelAccount: {
      async findFirst({ where } = {}) {
        for (const acc of accounts.values()) {
          if (where.id && acc.id !== where.id) continue;
          if (where.workspaceId && acc.workspaceId !== where.workspaceId) continue;
          if (where.platform && acc.platform !== where.platform) continue;
          if (where.externalId?.in && !where.externalId.in.includes(acc.externalId)) continue;
          return { ...acc };
        }
        return null;
      },
      async findMany({ where } = {}) {
        return [...accounts.values()]
          .filter((acc) => (!where?.workspaceId || acc.workspaceId === where.workspaceId)
            && (!where?.platform || acc.platform === where.platform))
          .map((acc) => ({ ...acc }));
      },
      async create({ data }) {
        if (failNextAccountWrite) {
          throw new Error('simulated database write timeout');
        }
        const row = { ...data, archivedAt: null };
        accounts.set(row.id, row);
        return { ...row };
      },
      async update({ where, data }) {
        if (failNextAccountWrite) {
          throw new Error('simulated database write timeout');
        }
        const row = accounts.get(where.id);
        Object.assign(row, data);
        return { ...row };
      },
    },
    accountRiskEvent: {
      async updateMany() {
        return { count: 0 };
      },
    },
    async $transaction(fn) {
      const tx = {
        $queryRaw: async () => [],
        channelAccount: prisma.channelAccount,
        accountRiskEvent: prisma.accountRiskEvent,
      };
      return fn(tx);
    },
  };
  return prisma;
}

function makeService(prisma) {
  return new AccountOnboardingService(prisma, {
    assertWorkspaceGroup: async (_p, _ws, groupId) => groupId ?? null,
  });
}

function jsonResponse(body, init = {}) {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

function responseWithCookies(body, cookies) {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const cookie of cookies) {
    headers.append('set-cookie', cookie);
  }
  return new Response(JSON.stringify(body), { status: 200, headers });
}

async function withMockFetch(handler, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => handler(String(input), init);
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('Bilibili QR onboarding state machine & regression suite', () => {
  test('extractCookiesFromResponse handles multi Set-Cookie and fallback callback query', () => {
    const res = responseWithCookies(
      { code: 0, data: { code: 0 } },
      [
        'SESSDATA=abc%2C123; Path=/; Domain=.bilibili.com; HttpOnly; Expires=Wed, 01 Dec 2027 00:00:00 GMT',
        'bili_jct=csrf_tok; Path=/; Domain=.bilibili.com',
        'DedeUserID=998877; Path=/; Domain=.bilibili.com',
      ],
    );
    const extracted = extractCookiesFromResponse(res);
    assert.equal(extracted.hasSessdata, true);
    assert.equal(extracted.hasBiliJct, true);
    assert.equal(extracted.hasDedeUserId, true);
    assert.match(extracted.cookieHeader, /SESSDATA=abc%2C123/);

    const resUrlFallback = new Response('{}', { status: 200 });
    const fromUrl = extractCookiesFromResponse(
      resUrlFallback,
      'https://passport.biligame.com/x/passport-login/web/login?DedeUserID=12345&SESSDATA=url_sess&bili_jct=url_jct',
    );
    assert.equal(fromUrl.hasSessdata, true);
    assert.match(fromUrl.cookieHeader, /DedeUserID=12345/);
  });

  test('normal flow: generate -> 86101 waiting -> 86090 scanned -> 0 confirmed -> verify -> save -> CONNECTED', async () => {
    const prisma = createInMemoryPrisma();
    const service = makeService(prisma);
    const qrKey = 'k_normal_123';
    const qrUrl = `https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=${qrKey}&navhide=1`;
    let pollStep = 0;

    await withMockFetch(async (url) => {
      if (url.includes('/qrcode/generate')) {
        return jsonResponse({ code: 0, data: { url: qrUrl, qrcode_key: qrKey } });
      }
      if (url.includes('/qrcode/poll')) {
        pollStep += 1;
        if (pollStep === 1) return jsonResponse({ code: 0, data: { code: 86101, message: '未扫码' } });
        if (pollStep === 2) return jsonResponse({ code: 0, data: { code: 86090, message: '已扫码未确认' } });
        return responseWithCookies(
          { code: 0, data: { code: 0, url: 'https://www.bilibili.com' } },
          [
            'SESSDATA=valid_sessdata; Path=/; HttpOnly',
            'bili_jct=valid_jct; Path=/',
            'DedeUserID=1008611; Path=/',
          ],
        );
      }
      if (url.includes('/x/web-interface/nav')) {
        return jsonResponse({ code: 0, data: { isLogin: true, mid: 1008611, uname: '测试UP主' } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }, async () => {
      const started = await service.startBilibiliWebQr('ws-1', 'user-1');
      assert.equal(started.state, 'WAITING_SCAN');
      assert.equal(started.status, 'pending');
      assert.equal(started.verificationUrl, qrUrl);

      const waiting = await service.pollBilibiliWebQr('ws-1', 'user-1', started.id, true);
      assert.equal(waiting.state, 'WAITING_SCAN');
      assert.equal(waiting.code, 86101);

      const scanned = await service.pollBilibiliWebQr('ws-1', 'user-1', started.id, true);
      assert.equal(scanned.state, 'SCANNED');
      assert.equal(scanned.status, 'scanned');
      assert.equal(scanned.code, 86090);

      const connected = await service.pollBilibiliWebQr('ws-1', 'user-1', started.id, true);
      assert.equal(connected.state, 'CONNECTED');
      assert.equal(connected.status, 'connected');
      assert.ok(connected.accountId);

      // Secrets must be cleared on terminal state
      const ticketRow = prisma._tickets.get(started.id);
      assert.equal(ticketRow.qrcodeKeyCiphertext, null);
      assert.equal(ticketRow.tempCookieCiphertext, null);
      assert.equal(prisma._accounts.size, 1);

      // Re-scanning same UID updates existing account cleanly
      pollStep = 2;
      const started2 = await service.startBilibiliWebQr('ws-1', 'user-1');
      const connected2 = await service.pollBilibiliWebQr('ws-1', 'user-1', started2.id, true);
      assert.equal(connected2.accountId, connected.accountId);
      assert.equal(prisma._accounts.size, 1);
    });
  });

  test('manual=false respects polling throttle while manual=true checks immediately', async () => {
    const prisma = createInMemoryPrisma();
    const service = makeService(prisma);
    let upstreamPolls = 0;

    await withMockFetch(async (url) => {
      if (url.includes('/qrcode/generate')) {
        return jsonResponse({
          code: 0,
          data: { url: 'https://passport.bilibili.com/scan?qrcode_key=k_throttle', qrcode_key: 'k_throttle' },
        });
      }
      if (url.includes('/qrcode/poll')) {
        upstreamPolls += 1;
        return jsonResponse({ code: 0, data: { code: 86101 } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }, async () => {
      const started = await service.startBilibiliWebQr('ws-1', 'user-1');
      await service.pollBilibiliWebQr('ws-1', 'user-1', started.id, false);
      assert.equal(upstreamPolls, 0, 'immediate auto poll inside 1.5s window should reuse state');

      await service.pollBilibiliWebQr('ws-1', 'user-1', started.id, true);
      assert.equal(upstreamPolls, 1, 'manual poll bypasses 1.5s throttle');
    });
  });

  test('cancel & regenerate superseding behavior', async () => {
    const prisma = createInMemoryPrisma();
    const service = makeService(prisma);

    await withMockFetch(async (url) => {
      if (url.includes('/qrcode/generate')) {
        const key = randomUUID();
        return jsonResponse({
          code: 0,
          data: { url: `https://passport.bilibili.com/scan?qrcode_key=${key}`, qrcode_key: key },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }, async () => {
      const t1 = await service.startBilibiliWebQr('ws-1', 'user-1');
      const canceled = await service.cancelBilibiliWebQr('ws-1', 'user-1', t1.id);
      assert.equal(canceled.state, 'CANCELED');
      assert.equal(prisma._tickets.get(t1.id).qrcodeKeyCiphertext, null);

      const t2 = await service.startBilibiliWebQr('ws-1', 'user-1');
      const t3 = await service.startBilibiliWebQr('ws-1', 'user-1');
      assert.equal(prisma._tickets.get(t2.id).state, 'CANCELED');
      assert.equal(prisma._tickets.get(t3.id).state, 'WAITING_SCAN');
    });
  });

  test('abnormal generate responses (timeout, non-JSON, HTTP 500/429, key mismatch)', async () => {
    const prisma = createInMemoryPrisma();
    const service = makeService(prisma);

    await withMockFetch(async () => {
      throw new DOMException('Timed out', 'TimeoutError');
    }, async () => {
      await assert.rejects(() => service.startBilibiliWebQr('ws-1', 'user-1'), /超时/);
    });

    await withMockFetch(async () => new Response('<html>502</html>', { status: 200 }), async () => {
      await assert.rejects(() => service.startBilibiliWebQr('ws-1', 'user-1'), /格式异常/);
    });

    await withMockFetch(async () => new Response('{}', { status: 502 }), async () => {
      await assert.rejects(() => service.startBilibiliWebQr('ws-1', 'user-1'), /HTTP 502/);
    });

    await withMockFetch(async () => new Response('{}', { status: 429 }), async () => {
      await assert.rejects(() => service.startBilibiliWebQr('ws-1', 'user-1'), /受限/);
    });

    await withMockFetch(async () => jsonResponse({
      code: 0,
      data: { url: 'https://passport.bilibili.com/scan?qrcode_key=other', qrcode_key: 'expected' },
    }), async () => {
      await assert.rejects(() => service.startBilibiliWebQr('ws-1', 'user-1'), /参数不一致/);
    });
  });

  test('abnormal poll network/rate-limit/HTTP errors do NOT mark QR_EXPIRED; real 86038 marks QR_EXPIRED', async () => {
    const prisma = createInMemoryPrisma();
    const service = makeService(prisma);
    let pollBehavior = 'timeout';

    await withMockFetch(async (url) => {
      if (url.includes('/qrcode/generate')) {
        return jsonResponse({
          code: 0,
          data: { url: 'https://passport.bilibili.com/scan?qrcode_key=k_net', qrcode_key: 'k_net' },
        });
      }
      if (url.includes('/qrcode/poll')) {
        if (pollBehavior === 'timeout') throw new DOMException('Timed out', 'TimeoutError');
        if (pollBehavior === 'non_json') return new Response('not-json', { status: 200 });
        if (pollBehavior === 'http_500') return new Response('err', { status: 500 });
        if (pollBehavior === 'http_429') return new Response('{}', { status: 429 });
        if (pollBehavior === 'bili_ratelimit') return jsonResponse({ code: 0, data: { code: -412, message: '请求被拦截' } });
        if (pollBehavior === 'scanned') return jsonResponse({ code: 0, data: { code: 86090 } });
        return jsonResponse({ code: 0, data: { code: 86038, message: '二维码已失效' } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }, async () => {
      const t = await service.startBilibiliWebQr('ws-1', 'user-1');

      pollBehavior = 'timeout';
      const rTimeout = await service.pollBilibiliWebQr('ws-1', 'user-1', t.id, true);
      assert.equal(rTimeout.state, 'NETWORK_ERROR');
      assert.equal(rTimeout.businessState, 'WAITING_SCAN');

      pollBehavior = 'non_json';
      const rNonJson = await service.pollBilibiliWebQr('ws-1', 'user-1', t.id, true);
      assert.equal(rNonJson.state, 'NETWORK_ERROR');

      pollBehavior = 'http_500';
      const r500 = await service.pollBilibiliWebQr('ws-1', 'user-1', t.id, true);
      assert.equal(r500.state, 'NETWORK_ERROR');

      pollBehavior = 'http_429';
      const r429 = await service.pollBilibiliWebQr('ws-1', 'user-1', t.id, true);
      assert.equal(r429.state, 'RATE_LIMITED');
      assert.equal(r429.retryAfterMs, 5000);

      pollBehavior = 'bili_ratelimit';
      const r412 = await service.pollBilibiliWebQr('ws-1', 'user-1', t.id, true);
      assert.equal(r412.state, 'RATE_LIMITED');

      pollBehavior = 'scanned';
      const rScanned = await service.pollBilibiliWebQr('ws-1', 'user-1', t.id, true);
      assert.equal(rScanned.state, 'SCANNED');

      pollBehavior = 'expired';
      const rExpired = await service.pollBilibiliWebQr('ws-1', 'user-1', t.id, true);
      assert.equal(rExpired.state, 'QR_EXPIRED');
      assert.equal(rExpired.code, 86038);
      assert.equal(prisma._tickets.get(t.id).qrcodeKeyCiphertext, null);
    });
  });

  test('code=0 missing SESSDATA or nav -101 produces VERIFY_FAILED (never QR_EXPIRED)', async () => {
    const prisma = createInMemoryPrisma();
    const service = makeService(prisma);
    let mode = 'missing_sessdata';

    await withMockFetch(async (url) => {
      if (url.includes('/qrcode/generate')) {
        const key = randomUUID();
        return jsonResponse({
          code: 0,
          data: { url: `https://passport.bilibili.com/scan?qrcode_key=${key}`, qrcode_key: key },
        });
      }
      if (url.includes('/qrcode/poll')) {
        if (mode === 'missing_sessdata') {
          return responseWithCookies({ code: 0, data: { code: 0 } }, ['bili_jct=only_jct; Path=/']);
        }
        return responseWithCookies(
          { code: 0, data: { code: 0 } },
          ['SESSDATA=bad_sess; Path=/', 'bili_jct=jct; Path=/', 'DedeUserID=42; Path=/'],
        );
      }
      if (url.includes('/x/web-interface/nav')) {
        return jsonResponse({ code: -101, data: { isLogin: false } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }, async () => {
      const t1 = await service.startBilibiliWebQr('ws-1', 'user-1');
      const res1 = await service.pollBilibiliWebQr('ws-1', 'user-1', t1.id, true);
      assert.equal(res1.state, 'VERIFY_FAILED');
      assert.match(res1.message, /SESSDATA/);

      mode = 'nav_invalid';
      const t2 = await service.startBilibiliWebQr('ws-1', 'user-1');
      const res2 = await service.pollBilibiliWebQr('ws-1', 'user-1', t2.id, true);
      assert.equal(res2.state, 'VERIFY_FAILED');
      assert.equal(prisma._tickets.get(t2.id).tempCookieCiphertext, null);
    });
  });

  test('DB save failure -> SAVE_FAILED -> retry succeeds without re-calling Bilibili poll + restart recovery', async () => {
    const prisma = createInMemoryPrisma({ failAccountWrite: true });
    const service1 = makeService(prisma);
    let biliPollCount = 0;
    let navCount = 0;

    await withMockFetch(async (url) => {
      if (url.includes('/qrcode/generate')) {
        return jsonResponse({
          code: 0,
          data: { url: 'https://passport.bilibili.com/scan?qrcode_key=k_save', qrcode_key: 'k_save' },
        });
      }
      if (url.includes('/qrcode/poll')) {
        biliPollCount += 1;
        return responseWithCookies(
          { code: 0, data: { code: 0 } },
          ['SESSDATA=good_sess; Path=/', 'bili_jct=good_jct; Path=/', 'DedeUserID=777888; Path=/'],
        );
      }
      if (url.includes('/x/web-interface/nav')) {
        navCount += 1;
        return jsonResponse({ code: 0, data: { isLogin: true, mid: 777888, uname: '恢复测试号' } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }, async () => {
      const t = await service1.startBilibiliWebQr('ws-1', 'user-1');
      const failedSave = await service1.pollBilibiliWebQr('ws-1', 'user-1', t.id, true);
      assert.equal(failedSave.state, 'SAVE_FAILED');
      assert.equal(failedSave.canRetry, true);
      assert.equal(biliPollCount, 1);
      assert.equal(navCount, 1);

      // Simulate API restart with a fresh service instance sharing DB state
      const service2 = makeService(prisma);
      const active = await service2.getActiveBilibiliWebQr('ws-1', 'user-1');
      assert.ok(active);
      assert.equal(active.id, t.id);
      assert.equal(active.state, 'SAVE_FAILED');

      // Recover DB and retry save without touching Bilibili poll or nav again
      prisma.setFailAccountWrite(false);
      const recovered = await service2.pollBilibiliWebQr('ws-1', 'user-1', t.id, true);
      assert.equal(recovered.state, 'CONNECTED');
      assert.ok(recovered.accountId);
      assert.equal(biliPollCount, 1, 'must NOT re-call Bilibili qrcode/poll after code=0');
      assert.equal(navCount, 1, 'cached mid/uname avoids redundant nav call');
      assert.equal(prisma._tickets.get(t.id).tempCookieCiphertext, null);
    });
  });

  test('ownership isolation across users/workspaces + concurrent generate/poll locks', async () => {
    const prisma = createInMemoryPrisma();
    const service = makeService(prisma);

    await withMockFetch(async (url) => {
      if (url.includes('/qrcode/generate')) {
        return jsonResponse({
          code: 0,
          data: { url: 'https://passport.bilibili.com/scan?qrcode_key=k_iso', qrcode_key: 'k_iso' },
        });
      }
      if (url.includes('/qrcode/poll')) {
        await new Promise((r) => setTimeout(r, 40));
        return jsonResponse({ code: 0, data: { code: 86101 } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }, async () => {
      const t = await service.startBilibiliWebQr('ws-1', 'user-1');
      await assert.rejects(() => service.pollBilibiliWebQr('ws-1', 'user-2', t.id, true), /不存在/);
      await assert.rejects(() => service.pollBilibiliWebQr('ws-2', 'user-1', t.id, true), /不存在/);
      await assert.rejects(() => service.cancelBilibiliWebQr('ws-1', 'user-2', t.id), /不存在/);

      // Concurrent polls on the same ticket only issue one upstream poll request
      let upstreamConcurrentPolls = 0;
      const origFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        if (String(input).includes('/qrcode/poll')) upstreamConcurrentPolls += 1;
        return origFetch(input, init);
      };
      await Promise.all([
        service.pollBilibiliWebQr('ws-1', 'user-1', t.id, true),
        service.pollBilibiliWebQr('ws-1', 'user-1', t.id, true),
      ]);
      assert.equal(upstreamConcurrentPolls, 1, 'atomic ticket lock prevents overlapping upstream polls');
    });

    // Concurrent generate for same (workspaceId, userId)
    let releaseGenerate;
    const gate = new Promise((r) => { releaseGenerate = r; });
    await withMockFetch(async () => {
      await gate;
      return jsonResponse({
        code: 0,
        data: { url: 'https://passport.bilibili.com/scan?qrcode_key=k_dup', qrcode_key: 'k_dup' },
      });
    }, async () => {
      const first = service.startBilibiliWebQr('ws-1', 'user-99');
      await assert.rejects(() => service.startBilibiliWebQr('ws-1', 'user-99'), /正在生成二维码/);
      releaseGenerate();
      await first;
    });
  });
});
