// SPDX-License-Identifier: AGPL-3.0-only
//
// The local runner's hold on its home (LA-1): one runner at a time, so two
// never read the same ledger total and both start under the cap. The hold is
// a lock file, `<home>/runner.lock`, naming the runner's process and its hold.

import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/**
 * Hold the home for this runner: a second runner on the same ledger would read
 * the same total and both start under the cap. A lock left by a process that
 * has gone is moved aside, then a new one created where none is, so of two
 * runners taking it over at once one holds the home and the other is refused.
 */
export function holdHome(home: string): () => void {
  mkdirSync(home, { recursive: true });
  const lock = `${home}/runner.lock`;
  // The process and this hold: runners in one process each hold their own.
  const mine = `${String(process.pid)} ${randomUUID()}`;
  if (!created(lock, mine)) {
    setAside(lock);
    if (!created(lock, mine)) throw inUse();
  }
  return () => {
    // Only this runner's own lock goes: a later runner's hold on the home stays.
    let held: string;
    try {
      held = readFileSync(lock, 'utf8');
    } catch {
      return;
    }
    if (held === mine) rmSync(lock, { force: true });
  };
}

const inUse = (): Error =>
  new Error('LOCAL_HOME_IN_USE: another runner holds this OPS_LOCAL_AGENT_HOME');

/** The lock written where none is; false when one already is. */
function created(lock: string, text: string): boolean {
  try {
    writeFileSync(lock, text, { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Move a gone runner's lock aside. Only one runner's move of it succeeds, and
 * the file moved must still be the one read: a lock another runner took over
 * in between is put back, and this runner refused.
 */
function setAside(lock: string): void {
  let seen: string;
  try {
    seen = readFileSync(lock, 'utf8');
  } catch {
    return;
  }
  const holder = Number(seen.split(' ', 1)[0]);
  if (Number.isSafeInteger(holder) && holder > 0 && alive(holder)) throw inUse();
  const aside = `${lock}.${randomUUID()}`;
  try {
    renameSync(lock, aside);
  } catch {
    throw inUse();
  }
  const moved = readFileSync(aside, 'utf8');
  if (moved !== seen) {
    try {
      linkSync(aside, lock);
    } catch {
      // A third runner holds the home now; it keeps it.
    }
  }
  rmSync(aside, { force: true });
  if (moved !== seen) throw inUse();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
