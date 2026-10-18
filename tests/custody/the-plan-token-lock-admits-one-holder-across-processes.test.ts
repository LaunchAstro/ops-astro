// SPDX-License-Identifier: AGPL-3.0-only
//
// #1620 P1 proof 1: the plan token lock is one kernel lock (Node 24
// `node:sqlite`, `BEGIN EXCLUSIVE`) that admits one holder across processes,
// survives a killed or suspended holder, refuses a lock file or directory
// others can touch, and leaves a dead `HeldLock` able to read or write nothing.

import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import {
  commitTokenFile,
  readTokenFileLocked,
  type TokenFile,
} from '../../packages/core-custody/src/token-file.ts';
import { withTokenLock, type HeldLock } from '../../packages/core-custody/src/token-lock.ts';
import {
  HOUR,
  T0,
  runChild,
  tempDir,
  tokens,
  type ChildRun,
  sleep,
} from './fixtures/plan-token-world.ts';

const worlds: { done(): void }[] = [];
const children: ChildRun[] = [];
afterEach(() => {
  for (const run of children.splice(0)) run.child.kill('SIGKILL');
  for (const world of worlds.splice(0)) world.done();
});
const world = () => {
  const w = tempDir();
  worlds.push(w);
  return w;
};
const hold = (file: string, id: string, log: string, ms: number, deadlineMs = 20_000) => {
  const run = runChild({ op: 'hold', file, id, log, ms, deadlineMs });
  children.push(run);
  return run;
};
/** The child's final message, past its `held` notice. */
const finished = async (run: ChildRun): Promise<Record<string, unknown>> => {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each step must finish before the next, in order
    const message = await run.next();
    if (message['held'] !== true) return message;
  }
};
const intervals = (log: string) => {
  const lines = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => l.split(' '));
  const spans = new Map<string, [number, number]>();
  for (const [what, id, at] of lines) {
    const span = spans.get(id!) ?? [Number.NaN, Number.NaN];
    span[what === 'enter' ? 0 : 1] = Number(at);
    spans.set(id!, span);
  }
  return [...spans.entries()];
};
const noOverlap = (spans: [string, [number, number]][]) => {
  const sorted = spans.map(([, s]) => s).toSorted((a, b) => a[0] - b[0]);
  for (let i = 1; i < sorted.length; i += 1)
    expect(sorted[i]![0]).toBeGreaterThanOrEqual(sorted[i - 1]![1]);
};

const work = () => Promise.resolve('ran');
const soon = () => ({ deadlineAt: Date.now() + 500 });

it('node:sqlite imports under the locked Vitest and under process.execPath with empty stderr', () => {
  expect(process.versions.node.startsWith('24.')).toBe(true);
  const stderr = execFileSync(process.execPath, ['-e', "require('node:sqlite')"], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  expect(stderr.toString()).toBe('');
});

it('a holder killed with SIGKILL frees the lock, B and C race, a fourth waits while B holds', async () => {
  const { file, dir } = world();
  const log = `${dir}/holds.log`;
  const a = hold(file, 'a', log, -1);
  await a.next();
  a.child.kill('SIGKILL');
  await a.exited();
  const b = hold(file, 'b', log, 300);
  const c = hold(file, 'c', log, 300);
  await Promise.race([b.next(), c.next()]);
  const d = hold(file, 'd', log, 50);
  // oxlint-disable-next-line no-await-in-loop -- each step must finish before the next, in order
  for (const run of [b, c, d]) expect(await finished(run)).toEqual({ done: true });
  noOverlap(intervals(log).filter(([id]) => id !== 'a'));
  expect(
    intervals(log)
      .map(([id]) => id)
      .toSorted(),
  ).toEqual(['a', 'b', 'c', 'd']);
}, 20_000);

it('a SIGSTOP holder excludes everyone until SIGCONT and release', async () => {
  const { file, dir } = world();
  const log = `${dir}/holds.log`;
  const a = hold(file, 'a', log, 600);
  await a.next();
  a.child.kill('SIGSTOP');
  const b = hold(file, 'b', log, 10);
  await sleep(1_200);
  expect(readFileSync(log, 'utf8')).not.toContain('enter b');
  a.child.kill('SIGCONT');
  expect(await finished(a)).toEqual({ done: true });
  expect(await finished(b)).toEqual({ done: true });
  noOverlap(intervals(log));
}, 20_000);

it('three holders in one process take turns, and a waiter enters after release', async () => {
  const { file } = world();
  const spans: [string, [number, number]][] = [];
  const one = (id: string) =>
    withTokenLock(file, { deadlineAt: Date.now() + 5_000 }, async () => {
      const enter = performance.now();
      await sleep(60);
      spans.push([id, [enter, performance.now()]]);
    });
  const outs = await Promise.all(['x', 'y', 'z'].map((id) => one(id)));
  expect(outs.every((o) => o.held)).toBe(true);
  noOverlap(spans);
});

it("a failed contender's close keeps the holder's lock, and the wait lapses at its deadline", async () => {
  const { file, dir } = world();
  const log = `${dir}/holds.log`;
  const a = hold(file, 'a', log, -1);
  await a.next();
  const started = Date.now();
  expect(
    await withTokenLock(file, { deadlineAt: started + 300 }, () => Promise.resolve(1)),
  ).toEqual({
    held: false,
    why: 'LOCK_WAIT_LAPSED',
  });
  expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  const b = hold(file, 'b', log, 10, 400);
  expect(await b.next()).toEqual({ refused: 'LOCK_WAIT_LAPSED' });
  a.child.send('release');
  expect(await finished(a)).toEqual({ done: true });
}, 20_000);

it('a lock file or directory others can touch is LOCK_UNUSABLE, and a non-SQLite lock file keeps its bytes', async () => {
  const notSqlite = world();
  writeFileSync(`${notSqlite.file}.lock`, 'synthetic bytes that are not a database', {
    mode: 0o600,
  });
  expect(await withTokenLock(notSqlite.file, soon(), work)).toEqual({
    held: false,
    why: 'LOCK_UNUSABLE',
  });
  expect(readFileSync(`${notSqlite.file}.lock`, 'utf8')).toBe(
    'synthetic bytes that are not a database',
  );

  const open = world();
  writeFileSync(`${open.file}.lock`, '', { mode: 0o644 });
  chmodSync(`${open.file}.lock`, 0o644);
  expect(await withTokenLock(open.file, soon(), work)).toEqual({
    held: false,
    why: 'LOCK_UNUSABLE',
  });

  const linked = world();
  writeFileSync(`${linked.dir}/elsewhere`, '', { mode: 0o600 });
  symlinkSync(`${linked.dir}/elsewhere`, `${linked.file}.lock`);
  expect(await withTokenLock(linked.file, soon(), work)).toEqual({
    held: false,
    why: 'LOCK_UNUSABLE',
  });

  const shared = world();
  chmodSync(shared.dir, 0o755);
  expect(await withTokenLock(shared.file, soon(), work)).toEqual({
    held: false,
    why: 'LOCK_UNUSABLE',
  });
  expect(existsSync(`${shared.file}.lock`)).toBe(false);

  const healthy = world();
  expect(await withTokenLock(healthy.file, soon(), work)).toEqual({ held: true, value: 'ran' });
});

it('a dead HeldLock reads and writes nothing', async () => {
  const { file } = world();
  let kept: HeldLock | undefined;
  await withTokenLock(file, { deadlineAt: Date.now() + 1_000 }, (held) => {
    kept = held;
    return Promise.resolve();
  });
  const record: TokenFile = { state: 'ready', tokens: tokens('dead', T0 + HOUR) };
  expect(commitTokenFile(kept!, file, record)).toBe('unwritten');
  expect(existsSync(file)).toBe(false);
  expect(readTokenFileLocked(kept!, file)).toEqual({
    state: 'refused',
    code: 'SUBSCRIPTION_STORE_FAILED',
  });
});
