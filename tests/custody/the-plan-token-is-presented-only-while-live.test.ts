// SPDX-License-Identifier: AGPL-3.0-only
//
// #1620 P1 proof 5: `present()` answers only a pair a locked read last found
// ready and only while it is live by the clock read at the call. It reads no
// file, takes no lock and never refreshes.

import { rmSync, writeSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { REFRESH_AHEAD_MS, tokenHolder } from '../../packages/core-custody/src/plan-token.ts';
import type { TokenFs } from '../../packages/core-custody/src/token-file.ts';
import { startIssuer, type Issuer } from './fixtures/plan-issuer.ts';
import {
  HOUR,
  T0,
  faultyFs,
  runChild,
  seed,
  tempDir,
  tokens,
} from './fixtures/plan-token-world.ts';

let issuer: Issuer;
beforeAll(async () => {
  issuer = await startIssuer();
});
afterAll(() => issuer.close());
const worlds: { done(): void }[] = [];
afterEach(() => {
  issuer.onRequest(() => {});
  for (const w of worlds.splice(0)) w.done();
});
const world = () => {
  const w = tempDir();
  worlds.push(w);
  return w;
};

it('ported sol-1634-expiry-during-store: a pair that lapses while it is stored is not presented', async () => {
  const { file } = world();
  await seed(file, { state: 'ready', tokens: tokens('old', T0 + 4 * 60_000) });
  let at = T0;
  issuer.set({
    kind: 'json',
    status: 200,
    body: {
      access_token: 'synthetic-access-new',
      refresh_token: 'synthetic-refresh-new',
      expires_in: 400,
    },
  });
  // The clock moves while the rotated record is written, not while the
  // request is out, so the prepare deadline plays no part.
  const storing: Partial<TokenFs> = {
    writeSync: ((fd: number, buffer: Buffer, ...rest: []) => {
      if (buffer.toString('latin1', 0, 16) === '{"state":"ready"') at += 200_000;
      return writeSync(fd, buffer, ...rest);
    }) as TokenFs['writeSync'],
  };
  const holder = tokenHolder({ file, tokenUrl: issuer.url, now: () => at, fs: storing });
  expect(await holder.prepare()).toEqual({ ok: false, code: 'SUBSCRIPTION_REFRESH_FAILED' });
  expect(at).toBe(T0 + 200_000);
  expect(holder.present()).toEqual({ ok: false, code: 'SUBSCRIPTION_REFRESH_FAILED' });
});

it('ported sol-1634-expired-unwritten-token: an unwritten pair is never presented, even after it expires', async () => {
  const { file } = world();
  await seed(file, { state: 'ready', tokens: tokens('old', T0 + 4 * 60_000) });
  let at = T0;
  issuer.set({
    kind: 'json',
    status: 200,
    body: {
      access_token: 'synthetic-access-new',
      refresh_token: 'synthetic-refresh-new',
      expires_in: 3_600,
    },
  });
  const holder = tokenHolder({
    file,
    tokenUrl: issuer.url,
    now: () => at,
    fs: faultyFs({ step: 'rename', on: 'ready' }),
  });
  expect(await holder.prepare()).toEqual({ ok: false, code: 'SUBSCRIPTION_STORE_FAILED' });
  expect(holder.present()).toEqual({ ok: false, code: 'SUBSCRIPTION_REFRESH_FAILED' });
  at += 2 * HOUR;
  expect(holder.present()).toEqual({ ok: false, code: 'SUBSCRIPTION_REFRESH_FAILED' });
});

it('present() at exactly expiresAt - REFRESH_AHEAD_MS refuses, and one millisecond earlier answers', async () => {
  const { file } = world();
  await seed(file, { state: 'ready', tokens: tokens('a', T0 + HOUR) });
  let at = T0;
  const holder = tokenHolder({ file, tokenUrl: issuer.url, now: () => at });
  expect(await holder.prepare()).toEqual({ ok: true });
  at = T0 + HOUR - REFRESH_AHEAD_MS - 1;
  expect(holder.present().ok).toBe(true);
  at = T0 + HOUR - REFRESH_AHEAD_MS;
  expect(holder.present()).toEqual({ ok: false, code: 'SUBSCRIPTION_REFRESH_FAILED' });
});

it('a pending file is never presented, and a locked read of spent drops an earlier held pair', async () => {
  const { file } = world();
  await seed(file, { state: 'pending', tokens: tokens('a', T0 + HOUR), since: T0 });
  const fresh = tokenHolder({ file, tokenUrl: issuer.url, now: () => T0 });
  expect(await fresh.prepare()).toEqual({ ok: false, code: 'SUBSCRIPTION_SIGN_IN_NEEDED' });
  expect(fresh.present().ok).toBe(false);

  const other = world();
  await seed(other.file, { state: 'ready', tokens: tokens('b', T0 + HOUR) });
  const holder = tokenHolder({ file: other.file, tokenUrl: issuer.url, now: () => T0 });
  expect(await holder.prepare()).toEqual({ ok: true });
  await seed(other.file, { state: 'spent', subject: 'synthetic-subject-a' });
  expect(await holder.prepare()).toEqual({ ok: false, code: 'SUBSCRIPTION_SIGN_IN_NEEDED' });
  expect(holder.present()).toEqual({ ok: false, code: 'SUBSCRIPTION_REFRESH_FAILED' });
});

it('present reads nothing: with the file removed and another process holding the lock it answers at once', async () => {
  const { file } = world();
  await seed(file, { state: 'ready', tokens: tokens('a', T0 + HOUR) });
  const holder = tokenHolder({ file, tokenUrl: issuer.url, now: () => T0 });
  expect(await holder.prepare()).toEqual({ ok: true });
  const blocker = runChild({
    op: 'hold',
    file,
    id: 'b',
    log: `${file}.holds`,
    ms: -1,
    deadlineMs: 5_000,
  });
  await blocker.next();
  rmSync(file);
  const started = performance.now();
  expect(holder.present()).toEqual({ ok: true, accessToken: 'synthetic-access-a' });
  expect(performance.now() - started).toBeLessThan(50);
  blocker.child.send('release');
  await blocker.exited();
}, 20_000);

it('healthy: a call prepared before a same-process refresh presents its token during that refresh', async () => {
  const { file } = world();
  await seed(file, { state: 'ready', tokens: tokens('old', T0 + HOUR) });
  let at = T0;
  const holder = tokenHolder({ file, tokenUrl: issuer.url, now: () => at });
  expect(await holder.prepare()).toEqual({ ok: true });
  at = T0 + HOUR - 5 * 60_000 - 1;
  let during: unknown;
  issuer.set({
    kind: 'json',
    status: 200,
    body: {
      access_token: 'synthetic-access-new',
      refresh_token: 'synthetic-refresh-new',
      expires_in: 3_600,
    },
  });
  issuer.onRequest(() => {
    during = holder.present();
  });
  expect(await holder.prepare()).toEqual({ ok: true });
  expect(during).toEqual({ ok: true, accessToken: 'synthetic-access-old' });
  expect(holder.present()).toEqual({ ok: true, accessToken: 'synthetic-access-new' });
});
