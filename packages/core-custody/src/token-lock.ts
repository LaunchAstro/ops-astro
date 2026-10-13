// SPDX-License-Identifier: AGPL-3.0-only
//
// The plan token file's lock (#1620): one file beside it, made exclusively,
// held by custody from the read before a refresh to the write after it, and
// by the owner's sign-in while it writes. Waiting is bounded; a lock older
// than LOCK_STALE_MS was abandoned (its holder died) and is taken over.

import { closeSync, openSync, statSync, unlinkSync } from 'node:fs';

/** How long a lock is waited for, and how old a lock is before it is taken as abandoned. */
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 60_000;

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
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx', 0o600));
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
      } catch {
        // Gone meanwhile: try again.
      }
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
    try {
      unlinkSync(lock);
    } catch {
      // Taken over as stale: nothing of ours to remove.
    }
  }
}
