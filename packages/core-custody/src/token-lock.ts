// SPDX-License-Identifier: AGPL-3.0-only
//
// The plan token file's lock (#1620): one file beside it, made exclusively,
// held by custody from the read before a refresh to the write after it, and
// by the owner's sign-in while it writes. Waiting is bounded; a lock older
// than LOCK_STALE_MS was abandoned (its holder died) and is taken over.
//
// Each holder writes its own random id into the lock, and removes a lock only
// while it still holds the id expected: its own on release, the abandoned
// one's on takeover. A holder that resumes after its lock was taken over
// therefore leaves its successor's lock in place, and no third holder enters
// while the successor still refreshes or writes. Taking over an abandoned lock
// is one atomic rename (`takeOverIfStale`).

import { randomBytes } from 'node:crypto';
import {
  linkSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

/** How long a lock is waited for, and how old a lock is before it is taken as abandoned. */
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 60_000;

/** The id a lock holds, or undefined when there is no lock to read. */
function holderOf(lock: string): string | undefined {
  try {
    return readFileSync(lock, 'utf8');
  } catch {
    return undefined;
  }
}

/** Remove the lock only while it still holds `id`. */
function removeIfHeldBy(lock: string, id: string): void {
  if (holderOf(lock) !== id) return;
  try {
    unlinkSync(lock);
  } catch {
    // Gone meanwhile: nothing to remove.
  }
}

const ageOf = (path: string): number => Date.now() - statSync(path).mtimeMs;

/**
 * An abandoned lock taken out of the way by one atomic rename, so two waiters
 * cannot both remove it, and neither can remove a fresh lock made meanwhile:
 * a lock found fresh once moved is put back, unless another is there by then.
 */
export function takeOverIfStale(lock: string, age: (path: string) => number = ageOf): void {
  try {
    if (age(lock) <= LOCK_STALE_MS) return;
  } catch {
    return;
  }
  const aside = `${lock}.${randomBytes(6).toString('hex')}.stale`;
  try {
    renameSync(lock, aside);
  } catch {
    return;
  }
  try {
    if (age(aside) <= LOCK_STALE_MS) linkSync(aside, lock);
  } catch {
    // A new lock is there already: it stands.
  } finally {
    rmSync(aside, { force: true });
  }
}

/**
 * `work` under the token file's lock (`<file>.lock`, made exclusively), or
 * undefined when the lock was not had within LOCK_WAIT_MS. A lock older than
 * LOCK_STALE_MS was abandoned and is taken over.
 */
export async function withTokenLock<T>(
  file: string,
  work: () => Promise<T> | T,
): Promise<T | undefined> {
  const lock = `${file}.lock`;
  const id = randomBytes(16).toString('hex');
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      writeFileSync(lock, id, { mode: 0o600, flag: 'wx' });
      break;
    } catch {
      takeOverIfStale(lock);
      if (Date.now() > until) return undefined;
      // oxlint-disable-next-line no-await-in-loop -- one try at a time until the lock is had or the wait ends
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
  }
  try {
    return await work();
  } finally {
    removeIfHeldBy(lock, id);
  }
}
