// SPDX-License-Identifier: AGPL-3.0-only
//
// P1b regression proofs for the revision-2 findings (OA-P1Sol61 F2 to F4,
// OA-P1OpusAttack61 A2, A6) and Sol's coverage gap, through the real holder,
// real files, real SQLite, child processes and the loopback issuer.

import { chmodSync, copyFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { tokenHolder } from '../../packages/core-custody/src/plan-token.ts';
import {
  commitTokenFile,
  readTokenFileLocked,
} from '../../packages/core-custody/src/token-file.ts';
import { withTokenLock } from '../../packages/core-custody/src/token-lock.ts';
import { startIssuer } from './fixtures/plan-issuer.ts';
import { T0, faultyFs, holderInChild, seed, tempDir, tokens } from './fixtures/plan-token-world.ts';

const DUE = T0 + 240_000;
const rotation = (tag: string, expiresIn = 3_600) => ({
  kind: 'json' as const,
  status: 200,
  body: {
    access_token: `synthetic-access-${tag}`,
    refresh_token: `synthetic-refresh-${tag}`,
    expires_in: expiresIn,
  },
});
const onDisk = (file: string) =>
  withTokenLock(file, { deadlineAt: Date.now() + 1_000 }, (held) =>
    Promise.resolve(readTokenFileLocked(held, file)),
  );

it('pending storage crossing the deadline sends nothing and restores ready', async () => {
  const w = tempDir();
  const issuer = await startIssuer();
  let at = T0;
  try {
    await seed(w.file, { state: 'ready', tokens: tokens('late', DUE) });
    issuer.set(rotation('next'));
    const slow = tokenHolder({
      file: w.file,
      tokenUrl: issuer.url,
      now: () => at,
      fs: {
        renameSync: (from, to) => {
          renameSync(from, to);
          at = T0 + 31_000;
        },
      },
    });
    expect(await slow.prepare()).toEqual({ ok: false, code: 'SUBSCRIPTION_REFRESH_FAILED' });
    expect(issuer.count()).toBe(0);
    expect(await onDisk(w.file)).toEqual({
      held: true,
      value: { state: 'ready', tokens: tokens('late', DUE) },
    });
    const healthy = tokenHolder({ file: w.file, tokenUrl: issuer.url, now: () => at });
    expect(await healthy.prepare()).toEqual({ ok: true });
    expect(issuer.count()).toBe(1);
  } finally {
    await issuer.close();
    w.done();
  }
});

it('a fresh holder lists the locked pair while its refresh is carried, and only the new pair after', async () => {
  const w = tempDir();
  const issuer = await startIssuer();
  try {
    const old = tokens('inflight', DUE);
    await seed(w.file, { state: 'ready', tokens: old });
    issuer.set(rotation('next'));
    const holder = tokenHolder({ file: w.file, tokenUrl: issuer.url, now: () => T0 });
    let during: readonly string[] = [];
    issuer.onRequest(() => {
      during = holder.secrets();
    });
    expect(await holder.prepare()).toEqual({ ok: true });
    expect(issuer.count()).toBe(1);
    expect(during.includes(old.accessToken) && during.includes(old.refreshToken)).toBe(true);
    expect(holder.secrets().toSorted()).toEqual([
      'synthetic-access-next',
      'synthetic-refresh-next',
    ]);
  } finally {
    await issuer.close();
    w.done();
  }
});

it('a 0400 lock file refuses the holder and its child with no request', async () => {
  const w = tempDir();
  const issuer = await startIssuer();
  try {
    await seed(w.file, { state: 'ready', tokens: tokens('ro', DUE) });
    chmodSync(`${w.file}.lock`, 0o400);
    issuer.set(rotation('next'));
    const holder = tokenHolder({ file: w.file, tokenUrl: issuer.url, now: () => T0 });
    expect(await holder.prepare()).toEqual({ ok: false, code: 'SUBSCRIPTION_STORE_FAILED' });
    const child = await holderInChild(w.file, issuer.url, T0);
    expect(child.prepare).toBe('SUBSCRIPTION_STORE_FAILED');
    expect(child.output).toBe('');
    expect(issuer.count()).toBe(0);
  } finally {
    await issuer.close();
    w.done();
  }
});

it('a holder fenced by a replaced lock file cannot store pending, so the refresh token is sent once', async () => {
  const w = tempDir();
  const issuer = await startIssuer();
  try {
    await seed(w.file, { state: 'ready', tokens: tokens('first', DUE) });
    issuer.set(rotation('second'));
    const first = await withTokenLock(w.file, { deadlineAt: Date.now() + 5_000 }, async (held) => {
      const read = readTokenFileLocked(held, w.file);
      renameSync(`${w.file}.lock`, join(w.dir, 'aside'));
      const child = await holderInChild(w.file, issuer.url, T0);
      const pending = commitTokenFile(held, w.file, {
        state: 'pending',
        tokens: tokens('first', DUE),
        since: T0,
      });
      return { read: read.state, child: child.prepare, pending };
    });
    expect(first).toEqual({
      held: true,
      value: { read: 'ready', child: 'ok', pending: 'unwritten' },
    });
    expect(issuer.count()).toBe(1);
  } finally {
    await issuer.close();
    w.done();
  }
});

it('recovers the unwritten rotation after expiry, then refreshes with the rotated token', async () => {
  const w = tempDir();
  const issuer = await startIssuer();
  const sent: string[] = [];
  let at = T0;
  try {
    await seed(w.file, { state: 'ready', tokens: tokens('first', DUE) });
    issuer.onRequest((form) => {
      sent.push(form.get('refresh_token') ?? '');
    });
    issuer.set(rotation('second', 400));
    const holder = tokenHolder({
      file: w.file,
      tokenUrl: issuer.url,
      now: () => at,
      fs: faultyFs({ step: 'rename', on: 'ready' }),
    });
    expect(await holder.prepare()).toEqual({ ok: false, code: 'SUBSCRIPTION_STORE_FAILED' });
    at = T0 + 500_000;
    expect(holder.present().ok).toBe(false);
    issuer.set(rotation('third'));
    expect(await holder.prepare()).toEqual({ ok: true });
    expect(sent).toEqual(['synthetic-refresh-first', 'synthetic-refresh-second']);
    expect(holder.present()).toEqual({ ok: true, accessToken: 'synthetic-access-third' });
  } finally {
    await issuer.close();
    w.done();
  }
});

it("the issuer's refusal of the reused token stores spent and asks for sign-in", async () => {
  const w = tempDir();
  const issuer = await startIssuer();
  try {
    await seed(w.file, { state: 'ready', tokens: tokens('first', DUE) });
    copyFileSync(w.file, join(w.dir, 'copy'));
    copyFileSync(`${w.file}.state`, join(w.dir, 'copy.state'));
    issuer.set(rotation('second'));
    const holder = tokenHolder({ file: w.file, tokenUrl: issuer.url, now: () => T0 });
    expect(await holder.prepare()).toEqual({ ok: true });
    renameSync(join(w.dir, 'copy'), w.file);
    renameSync(join(w.dir, 'copy.state'), `${w.file}.state`);
    issuer.set({ kind: 'json', status: 400, body: { error: 'invalid_grant' } });
    const restored = tokenHolder({ file: w.file, tokenUrl: issuer.url, now: () => T0 });
    expect(await restored.prepare()).toEqual({ ok: false, code: 'SUBSCRIPTION_SIGN_IN_NEEDED' });
    expect(await restored.prepare()).toEqual({ ok: false, code: 'SUBSCRIPTION_SIGN_IN_NEEDED' });
    expect(issuer.count()).toBe(2);
    expect(await onDisk(w.file)).toEqual({
      held: true,
      value: { state: 'spent', subject: 'synthetic-subject-a' },
    });
  } finally {
    await issuer.close();
    w.done();
  }
});
