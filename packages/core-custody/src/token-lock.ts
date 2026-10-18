// SPDX-License-Identifier: AGPL-3.0-only
//
// The plan token lock (#1620 P1): one kernel lock across processes, taken as
// an exclusive SQLite transaction on `<path>.lock` (Node 24 `node:sqlite`).
// The kernel drops it when the holder dies, so there is no stale judgement.
// It is a leaf lock: nothing waits on a database while holding it.
//
// No code here opens a descriptor on an existing lock file outside SQLite,
// since closing any descriptor on that file in this process would drop
// SQLite's POSIX locks. The lock file and the directory are judged with
// `lstat` and `ls` only.
//
// A hold is real only when its connection can write: a read-only connection's
// `BEGIN EXCLUSIVE` excludes nobody, so the hold proves it with a rolled-back
// write. A hold whose lock path no longer names the inode it locked is dead.
//
// If a same-user process deletes or replaces the lock file, two holders can
// overlap. The fences keep the refresh token sent once and nothing leaks, but
// the displaced holder can overwrite an in-progress rotation; the next use then
// asks for a fresh sign-in. Treat any SIGN_IN_NEEDED after such an event as
// expected.

import { execFileSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

declare const heldBrand: unique symbol;
/** Proof that the plan token lock for `path` is held right now. */
export interface HeldLock {
  readonly [heldBrand]: true;
  readonly path: string;
}
export type LockRefusal = 'LOCK_WAIT_LAPSED' | 'LOCK_UNUSABLE';

const RETRY_MS = 50;
/** Each live hold and the lock inode it locked. */
const live = new WeakMap<object, { readonly dev: number; readonly ino: number }>();

/** True while `held` is the live hold of the lock for `path` and the lock path still names its inode. */
export function holds(held: HeldLock, path: string): boolean {
  const locked = live.get(held);
  if (locked === undefined || held.path !== path) return false;
  try {
    const now = lstatSync(`${path}.lock`);
    return now.dev === locked.dev && now.ino === locked.ino;
  } catch {
    return false;
  }
}

/** Owned by this process's user and closed to everyone else by its mode bits. */
export function ownerOnly(stats: Stats): boolean {
  return stats.uid === process.getuid?.() && (stats.mode & 0o077) === 0;
}

/**
 * True when `path` carries no extended ACL, which can grant access the mode
 * bits do not show. macOS `ls -lde` prints one numbered line per ACL entry;
 * GNU `ls -ld` marks an ACL with `+` after the mode. Anything else refuses.
 */
export function aclFree(path: string): boolean {
  const mac = process.platform === 'darwin';
  try {
    const out = execFileSync('/bin/ls', [mac ? '-lde' : '-ld', '--', path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return mac ? !/^ *\d+: /mu.test(out) : out[10] !== '+';
  } catch {
    return false;
  }
}

function absent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

/**
 * Makes `path` an owner-only regular file if it is absent, then judges it.
 * Shared with the committed-digest database, which is checked the same way.
 */
export function privateFile(path: string): boolean {
  try {
    if (absent(path)) {
      try {
        closeSync(openSync(path, 'wx', 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      }
    }
    const stats = lstatSync(path);
    return stats.isFile() && !stats.isSymbolicLink() && ownerOnly(stats) && aclFree(path);
  } catch {
    return false;
  }
}

function usableDirectory(path: string): boolean {
  try {
    const stats = lstatSync(dirname(path));
    return stats.isDirectory() && ownerOnly(stats) && aclFree(dirname(path));
  } catch {
    return false;
  }
}

function busy(error: unknown): boolean {
  const code = (error as { errcode?: unknown }).errcode;
  return typeof code === 'number' && ((code & 0xff) === 5 || (code & 0xff) === 6);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * True when the held transaction can write (a rolled-back write to the main
 * schema; a read-only connection refuses it) and the lock path still names the
 * inode judged before the open.
 */
function provenHeld(db: DatabaseSync, lock: string, opened: Stats): boolean {
  try {
    db.exec(
      'SAVEPOINT probe; CREATE TABLE main.plan_token_lock_probe (x); ROLLBACK TO probe; RELEASE probe',
    );
    const locked = lstatSync(lock);
    return locked.dev === opened.dev && locked.ino === opened.ino;
  } catch {
    return false;
  }
}

/** Opens the lock database, with the inode judged just before the open. */
function openLock(lock: string): { readonly db: DatabaseSync; readonly opened: Stats } | undefined {
  try {
    const opened = lstatSync(lock);
    const db = new DatabaseSync(lock);
    db.exec('PRAGMA busy_timeout = 0');
    return { db, opened };
  } catch {
    return undefined;
  }
}

/**
 * Runs `work` while holding the plan token lock for `path`, waiting in 50 ms
 * steps until `deadlineAt` by `now`. The hold ends, and its `HeldLock` dies,
 * when `work` settles.
 */
export async function withTokenLock<T>(
  path: string,
  options: { readonly deadlineAt: number; readonly now?: () => number },
  work: (held: HeldLock) => Promise<T>,
): Promise<
  { readonly held: true; readonly value: T } | { readonly held: false; readonly why: LockRefusal }
> {
  const now = options.now ?? Date.now;
  const lock = `${path}.lock`;
  if (!usableDirectory(path) || !privateFile(lock)) return { held: false, why: 'LOCK_UNUSABLE' };
  const open = openLock(lock);
  if (open === undefined) return { held: false, why: 'LOCK_UNUSABLE' };
  const { db, opened } = open;
  try {
    for (;;) {
      try {
        db.exec('BEGIN EXCLUSIVE');
        break;
      } catch (error) {
        if (!busy(error)) return { held: false, why: 'LOCK_UNUSABLE' };
        if (now() >= options.deadlineAt) return { held: false, why: 'LOCK_WAIT_LAPSED' };
        // oxlint-disable-next-line no-await-in-loop -- one wait per refused attempt, to the deadline
        await sleep(RETRY_MS);
      }
    }
    // Judged after the last wait: a lock won past the deadline runs no work.
    const lapsed = now() >= options.deadlineAt;
    if (lapsed || !provenHeld(db, lock, opened))
      return { held: false, why: lapsed ? 'LOCK_WAIT_LAPSED' : 'LOCK_UNUSABLE' };
    // The probe is a synchronous file write, so the deadline is judged again after it.
    if (now() >= options.deadlineAt) return { held: false, why: 'LOCK_WAIT_LAPSED' };
    // The brand exists only at the type level; the WeakMap is the runtime proof.
    const held = Object.freeze({ path }) as unknown as HeldLock;
    live.set(held, { dev: opened.dev, ino: opened.ino });
    try {
      return { held: true, value: await work(held) };
    } finally {
      live.delete(held);
      try {
        db.exec('ROLLBACK');
      } catch {
        // Closing below ends the transaction either way.
      }
    }
  } finally {
    db.close();
  }
}
