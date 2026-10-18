// SPDX-License-Identifier: AGPL-3.0-only

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { tokenHolder } from '../../packages/core-custody/src/plan-token.ts';
import { startIssuer } from './fixtures/plan-issuer.ts';
import { T0, HOUR, seed, tempDir, tokens } from './fixtures/plan-token-world.ts';

it('concurrent holders rotate once after actual expiry with the exact refresh inputs', async () => {
  const w = tempDir();
  const issuer = await startIssuer();
  const old = tokens('expired', T0 + HOUR);
  let at = T0;
  let form: Record<string, string> = {};
  try {
    await seed(w.file, { state: 'ready', tokens: old });
    issuer.set({
      kind: 'json',
      status: 200,
      body: {
        access_token: 'synthetic-access-rotated',
        refresh_token: 'synthetic-refresh-rotated',
        expires_in: 3600,
      },
    });
    issuer.onRequest((f) => {
      form = Object.fromEntries(f);
    });
    const first = tokenHolder({ file: w.file, tokenUrl: issuer.url, now: () => at });
    const second = tokenHolder({ file: w.file, tokenUrl: issuer.url, now: () => at });
    expect(await first.prepare()).toEqual({ ok: true });
    at = old.expiresAt + 1;
    expect(first.present().ok).toBe(false);
    expect(await Promise.all([first.prepare(), second.prepare()])).toEqual([
      { ok: true },
      { ok: true },
    ]);
    expect(issuer.count()).toBe(1);
    expect(form).toEqual({
      grant_type: 'refresh_token',
      refresh_token: old.refreshToken,
      client_id: old.clientId,
      resource: 'https://api.openai.com/v1',
    });
    expect(first.present()).toEqual({ ok: true, accessToken: 'synthetic-access-rotated' });
    expect(second.present()).toEqual(first.present());
  } finally {
    await issuer.close();
    w.done();
  }
});

it('a redirect with a real Location never receives token text or a second request', async () => {
  const w = tempDir();
  const target = await startIssuer();
  let requests = 0;
  const redirect = createServer((_req, res) => {
    requests += 1;
    res.writeHead(302, { location: target.url.href });
    res.end();
  });
  await new Promise<void>((resolve) => redirect.listen(0, '127.0.0.1', resolve));
  try {
    await seed(w.file, { state: 'ready', tokens: tokens('redirect', T0 + 240_000) });
    const url = new URL(`http://127.0.0.1:${(redirect.address() as AddressInfo).port}/token`);
    const holder = tokenHolder({ file: w.file, tokenUrl: url, now: () => T0 });
    expect(await holder.prepare()).toEqual({ ok: false, code: 'SUBSCRIPTION_SIGN_IN_NEEDED' });
    expect(await holder.prepare()).toEqual({ ok: false, code: 'SUBSCRIPTION_SIGN_IN_NEEDED' });
    expect(requests).toBe(1);
    expect(target.count()).toBe(0);
  } finally {
    redirect.closeAllConnections();
    await new Promise<void>((resolve) => redirect.close(() => resolve()));
    await target.close();
    w.done();
  }
});
