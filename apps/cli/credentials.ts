// SPDX-License-Identifier: AGPL-3.0-only
//
// The command line's credential files: one bearer file, its delegation file
// and a helper's beside it make a set, and every change to a set follows the
// same rules, so any number of `ops-astro` processes can share it.
//
// - Publish: the value goes into a new file, created owner-only (`wx`, 0600),
//   then renamed over the target. A reader, which takes no lock, sees the old
//   whole file or the new one, and new bytes never enter a file someone else
//   could already read.
// - Lock: `<bearer file>.lock`, a directory, made and removed around local
//   file work only, never across a request. A lock left by a crash is named,
//   never taken over, so two holders cannot exist.
// - Epoch: `<bearer file>.epoch`, changed by every logout. A save records it
//   before its request and publishes only if it is unchanged, so a logout that
//   completes while a login or pickup waits for its answer wins.

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** How long a command waits for another to finish with the set, and how often it looks. */
const WAIT_MS = 3_000;
const STEP_MS = 25;

/** Another command holds the set's lock for longer than this one waits. */
export class CredentialsBusy extends Error {}

/** The file's content, trimmed, or nothing when it is missing or empty. */
export function readOptional(file: string): string | undefined {
  try {
    const value = readFileSync(file, 'utf8').trim();
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `change`, run while this process holds the set's lock. */
function underLock<T>(bearerFile: string, change: () => T): T {
  const lock = `${bearerFile}.lock`;
  mkdirSync(dirname(bearerFile), { recursive: true });
  const until = Date.now() + WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      if (Date.now() >= until) {
        throw new CredentialsBusy(
          `another ops-astro is changing these credentials; if none is running, remove ${lock}`,
        );
      }
      pause(STEP_MS);
    }
  }
  try {
    return change();
  } finally {
    rmdirSync(lock);
  }
}

const epochOf = (bearerFile: string): string => readOptional(`${bearerFile}.epoch`) ?? '';

/** `value` as a new owner-only file, renamed over `file`. */
function publish(file: string, value: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = openSync(temp, 'wx', 0o600);
    try {
      writeSync(handle, `${value}\n`);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temp, file);
  } catch (cause) {
    rmSync(temp, { force: true });
    throw cause;
  }
}

/** The set's epoch, read before a request whose answer will be saved. */
export function beginSave(bearerFile: string): string {
  return underLock(bearerFile, () => epochOf(bearerFile));
}

/** Saves `value` to `file` unless a logout ran since `epoch`; false when one did. */
export function saveUnlessSignedOut(
  bearerFile: string,
  epoch: string,
  file: string,
  value: string,
): boolean {
  return underLock(bearerFile, () => {
    if (epochOf(bearerFile) !== epoch) return false;
    publish(file, value);
    return true;
  });
}

/** Logout: a new epoch, then each file removed. Answers the files it could not remove, and why. */
export function signOut(bearerFile: string, files: readonly string[]): readonly string[] {
  return underLock(bearerFile, () => {
    publish(`${bearerFile}.epoch`, randomBytes(16).toString('hex'));
    const failed: string[] = [];
    for (const file of files) {
      try {
        rmSync(file, { force: true });
      } catch (cause) {
        failed.push(`${file}: ${(cause as Error).message}`);
      }
    }
    return failed;
  });
}

/** Removes `file` only if it still holds `value`, compared and removed under the lock. */
export function removeIfHolds(bearerFile: string, file: string, value: string): void {
  underLock(bearerFile, () => {
    if (readOptional(file) === value) rmSync(file, { force: true });
  });
}
