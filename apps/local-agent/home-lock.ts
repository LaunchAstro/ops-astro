// SPDX-License-Identifier: AGPL-3.0-only
//
// The local runner's hold on its home (LA-1): one runner at a time, so two
// never read the same ledger total and both start under the cap. The hold is
// a lock file, `<home>/runner.lock`, naming the runner's process and its hold.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/**
 * Hold the home for this runner: a second runner on the same ledger would read
 * the same total and both start under the cap. A lock left by a process that
 * has gone is replaced in place, never moved or removed, so the lock path always
 * names one runner and a runner that starts meanwhile is refused.
 */
export function holdHome(home: string): () => void {
  mkdirSync(home, { recursive: true });
  const lock = `${home}/runner.lock`;
  // The process and this hold: runners in one process each hold their own.
  const mine = `${String(process.pid)} ${randomUUID()}`;
  if (!created(lock, mine)) takeOver(lock, mine);
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

/** The lock's text, or undefined when there is none. */
function lockText(lock: string): string | undefined {
  try {
    return readFileSync(lock, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Take over a gone runner's lock. One runner at a time holds the takeover lock
 * beside it, and replaces the lock only while it is still the one read as gone.
 */
function takeOver(lock: string, mine: string): void {
  const seen = lockText(lock);
  if (seen === undefined) {
    // The holder let go in between: the home is free again.
    if (!created(lock, mine)) throw inUse();
    return;
  }
  const holder = Number(seen.split(' ', 1)[0]);
  // An empty lock is one a starting runner has made and not yet written.
  if (seen === '' || (Number.isSafeInteger(holder) && holder > 0 && alive(holder))) throw inUse();
  const takeover = `${lock}.takeover`;
  if (!created(takeover, mine)) {
    // Fail closed: a takeover left by a process that died is removed by hand.
    throw new Error(
      `LOCAL_HOME_IN_USE: another runner is taking over this OPS_LOCAL_AGENT_HOME; if no runner is running, remove ${takeover}`,
    );
  }
  const fresh = `${lock}.${randomUUID()}`;
  try {
    if (lockText(lock) !== seen) throw inUse();
    writeFileSync(fresh, mine, { flag: 'wx' });
    // One rename replaces the gone runner's lock: the path is never empty.
    renameSync(fresh, lock);
  } finally {
    rmSync(fresh, { force: true });
    rmSync(takeover, { force: true });
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
