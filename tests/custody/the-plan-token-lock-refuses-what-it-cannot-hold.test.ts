// SPDX-License-Identifier: AGPL-3.0-only
//
// P1a regression proofs for the revision-2 findings (OA-P1Sol61 F1, F3;
// OA-P1OpusAttack61 A1, A3a, A4, A7). A lock that cannot prove it is writable,
// or a file with an extended ACL, is refused, and the lock keeps its absolute
// deadline.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { readTokenFileLocked } from '../../packages/core-custody/src/token-file.ts';
import { withTokenLock } from '../../packages/core-custody/src/token-lock.ts';
import { HOUR, T0, runChild, seed, tempDir, tokens } from './fixtures/plan-token-world.ts';

const noop = (): void => {};
const soon = (): { deadlineAt: number } => ({ deadlineAt: Date.now() + 1_000 });
const acl = (entry: string, path: string): void => {
  execFileSync('/bin/chmod', ['+a', entry, path]);
};
const clearAcl = (path: string): void => {
  if (existsSync(path)) execFileSync('/bin/chmod', ['-N', path]);
};

it.each([
  ['0400 empty', 0o400, false],
  ['0400 SQLite database', 0o400, true],
  ['0500 empty', 0o500, false],
])('a lock file at %s gives LOCK_UNUSABLE and runs no work', async (_name, mode, database) => {
  const w = tempDir();
  try {
    if (database) {
      const db = new DatabaseSync(`${w.file}.lock`);
      db.exec('CREATE TABLE t (x)');
      db.close();
    } else await withTokenLock(w.file, soon(), () => Promise.resolve());
    chmodSync(`${w.file}.lock`, mode);
    let entered = false;
    const out = await withTokenLock(w.file, soon(), () => {
      entered = true;
      return Promise.resolve();
    });
    expect(out).toEqual({ held: false, why: 'LOCK_UNUSABLE' });
    expect(entered).toBe(false);
  } finally {
    w.done();
  }
});

it.each([
  [
    'chflags uchg',
    (l: string) => execFileSync('/usr/bin/chflags', ['uchg', l]),
    (l: string) => execFileSync('/usr/bin/chflags', ['nouchg', l]),
  ],
  ['an owner deny-write ACL', (l: string) => acl(`${userInfo().username} deny write`, l), clearAcl],
])('a 0600 lock file made read-only by %s gives LOCK_UNUSABLE', async (_name, apply, undo) => {
  const w = tempDir();
  const lock = `${w.file}.lock`;
  try {
    await withTokenLock(w.file, soon(), () => Promise.resolve());
    apply(lock);
    expect(lstatSync(lock).mode & 0o777).toBe(0o600);
    expect(await withTokenLock(w.file, soon(), () => Promise.resolve())).toEqual({
      held: false,
      why: 'LOCK_UNUSABLE',
    });
  } finally {
    undo(lock);
    w.done();
  }
});

it('healthy: a writable 0600 lock holds and a child contender lapses', async () => {
  const w = tempDir();
  try {
    await withTokenLock(w.file, soon(), async () => {
      const c = runChild({
        op: 'hold',
        file: w.file,
        id: 'b',
        log: join(w.dir, 'holds'),
        ms: 0,
        deadlineMs: 150,
      });
      expect(await c.next()).toEqual({ refused: 'LOCK_WAIT_LAPSED' });
      expect((await c.exited()).output).toBe('');
    });
    expect(readdirSync(w.dir).toSorted()).toEqual(['plan-token.json.lock']);
  } finally {
    w.done();
  }
});

it.each([
  ['directory', 'everyone allow list,search,add_file,delete_child'],
  ['lock', 'everyone allow read'],
  ['token', 'everyone allow read'],
  ['state', 'everyone allow read'],
])('an ACL on the %s leaves nothing ready to read', async (target, entry) => {
  const w = tempDir();
  const path =
    { directory: w.dir, lock: `${w.file}.lock`, token: w.file, state: `${w.file}.state` }[target] ??
    '';
  try {
    await seed(w.file, { state: 'ready', tokens: tokens('acl', T0 + HOUR) });
    acl(entry, path);
    expect(lstatSync(path).mode & 0o077).toBe(0);
    const out = await withTokenLock(w.file, soon(), (held) =>
      Promise.resolve(readTokenFileLocked(held, w.file)),
    );
    expect(out.held && out.value.state === 'ready').toBe(false);
    if (target === 'token')
      expect(out).toEqual({
        held: true,
        value: { state: 'refused', code: 'SUBSCRIPTION_TOKEN_FILE_OPEN' },
      });
    if (target === 'state')
      expect(out).toEqual({
        held: true,
        value: { state: 'refused', code: 'SUBSCRIPTION_STORE_FAILED' },
      });
    if (target === 'directory' || target === 'lock')
      expect(out).toEqual({ held: false, why: 'LOCK_UNUSABLE' });
  } finally {
    for (const p of [path, w.dir]) clearAcl(p);
    w.done();
  }
});

it('healthy: the same files without an ACL read ready', async () => {
  const w = tempDir();
  try {
    await seed(w.file, { state: 'ready', tokens: tokens('plain', T0 + HOUR) });
    const out = await withTokenLock(w.file, soon(), (held) =>
      Promise.resolve(readTokenFileLocked(held, w.file).state),
    );
    expect(out).toEqual({ held: true, value: 'ready' });
  } finally {
    w.done();
  }
});

it('a lock that frees after the deadline runs no work', async () => {
  const w = tempDir();
  let at = 0;
  let release: () => void = noop;
  let entered = false;
  const blocker = withTokenLock(
    w.file,
    soon(),
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  try {
    setTimeout(() => {
      at = 1_000;
      release();
    }, 20);
    const out = await withTokenLock(w.file, { deadlineAt: 500, now: () => at }, () => {
      entered = true;
      return Promise.resolve();
    });
    expect(out).toEqual({ held: false, why: 'LOCK_WAIT_LAPSED' });
    expect(entered).toBe(false);
  } finally {
    release();
    await blocker;
    w.done();
  }
});
