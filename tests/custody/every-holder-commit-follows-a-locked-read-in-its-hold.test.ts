// SPDX-License-Identifier: AGPL-3.0-only

// #1620 P1: every record the plan token holder commits is fenced to the
// generation it read. The fence (the committed digest a hold last observed)
// is set only by a locked read, so each commit must follow one in the same
// hold: `readTokenFileLocked`, or `committedDigest` where recovery judges the
// visible bytes itself. The token file module is wrapped only to record the
// order of those calls per hold; every call runs the real code.

import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { tokenHolder, type PlanLogKind } from '../../packages/core-custody/src/plan-token.ts';
import type * as TokenFileModule from '../../packages/core-custody/src/token-file.ts';
import { startIssuer, type Issuer } from './fixtures/plan-issuer.ts';
import { T0, faultyFs, seed, tempDir, tokens, type Fault } from './fixtures/plan-token-world.ts';

type Op = 'readTokenFileLocked' | 'committedDigest' | 'commitTokenFile';
const calls = vi.hoisted(() => [] as { op: Op; held: object; state?: string }[]);

vi.mock('../../packages/core-custody/src/token-file.ts', async (importOriginal) => {
  const real = await importOriginal<typeof TokenFileModule>();
  return {
    ...real,
    readTokenFileLocked: (...args: Parameters<typeof real.readTokenFileLocked>) => {
      calls.push({ op: 'readTokenFileLocked', held: args[0] });
      return real.readTokenFileLocked(...args);
    },
    committedDigest: (...args: Parameters<typeof real.committedDigest>) => {
      calls.push({ op: 'committedDigest', held: args[0] });
      return real.committedDigest(...args);
    },
    commitTokenFile: (...args: Parameters<typeof real.commitTokenFile>) => {
      calls.push({ op: 'commitTokenFile', held: args[0], state: args[2].state });
      return real.commitTokenFile(...args);
    },
  };
});

let issuer: Issuer;
beforeAll(async () => {
  issuer = await startIssuer();
});
afterAll(() => issuer.close());
const worlds: { done(): void }[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.done();
});

async function start(): Promise<string> {
  const w = tempDir();
  worlds.push(w);
  await seed(w.file, { state: 'ready', tokens: tokens('old', T0 + 4 * 60_000) });
  calls.splice(0);
  return w.file;
}

/** The state of each commit the holder made, after asserting each one followed a fence read in its hold. */
function commitsAfterFencedReads(): string[] {
  const fenced = new Set<object>();
  const committed: string[] = [];
  for (const call of calls) {
    if (call.op !== 'commitTokenFile') fenced.add(call.held);
    else {
      expect(
        fenced.has(call.held),
        `the ${call.state} commit follows a locked read in its hold`,
      ).toBe(true);
      committed.push(call.state ?? '');
    }
  }
  return committed;
}

const holder = (file: string, tokenUrl = issuer.url, fault?: Fault, logs: PlanLogKind[] = []) =>
  tokenHolder({
    file,
    tokenUrl,
    now: () => T0,
    log: (kind) => logs.push(kind),
    ...(fault === undefined ? {} : { fs: faultyFs(fault) }),
  });

it('a healthy rotation commits pending, then ready, each after a locked read in its hold', async () => {
  const file = await start();
  issuer.set({
    kind: 'json',
    status: 200,
    body: {
      access_token: 'synthetic-access-new',
      refresh_token: 'synthetic-refresh-new',
      expires_in: 3_600,
    },
  });
  expect(await holder(file).prepare()).toEqual({ ok: true });
  expect(commitsAfterFencedReads()).toEqual(['pending', 'ready']);
});

it('a rotated refresh token alone commits pending, then ready, each after a locked read in its hold', async () => {
  const file = await start();
  issuer.set({ kind: 'json', status: 200, body: { refresh_token: 'synthetic-refresh-rotated' } });
  expect(await holder(file).prepare()).toEqual({ ok: false, code: 'SUBSCRIPTION_REFRESH_FAILED' });
  expect(commitsAfterFencedReads()).toEqual(['pending', 'ready']);
});

it('a refused refresh commits pending, then spent, each after a locked read in its hold', async () => {
  const file = await start();
  issuer.set({ kind: 'json', status: 400, body: {} });
  expect(await holder(file).prepare()).toEqual({ ok: false, code: 'SUBSCRIPTION_SIGN_IN_NEEDED' });
  expect(commitsAfterFencedReads()).toEqual(['pending', 'spent']);
});

it('a request never sent restores ready after pending, each after a locked read in its hold', async () => {
  const file = await start();
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => {
    server.close(resolve);
  });
  const out = await holder(file, new URL(`http://127.0.0.1:${port}/token`)).prepare();
  expect(out).toEqual({ ok: false, code: 'SUBSCRIPTION_REFRESH_FAILED' });
  expect(commitsAfterFencedReads()).toEqual(['pending', 'ready']);
});

it("recovering the holder's unwritten pair commits it after a locked read in the recovering hold", async () => {
  const file = await start();
  issuer.set({
    kind: 'json',
    status: 200,
    body: {
      access_token: 'synthetic-access-new',
      refresh_token: 'synthetic-refresh-new',
      expires_in: 3_600,
    },
  });
  const logs: PlanLogKind[] = [];
  const live = holder(file, issuer.url, { step: 'dir-fsync-and-undo', on: 'ready' }, logs);
  expect(await live.prepare()).toEqual({ ok: false, code: 'SUBSCRIPTION_STORE_FAILED' });
  expect(commitsAfterFencedReads()).toEqual(['pending', 'ready']);
  calls.splice(0);
  expect(await live.prepare()).toEqual({ ok: true });
  expect(logs).toContain('token store recovered');
  expect(commitsAfterFencedReads()).toEqual(['ready']);
});
