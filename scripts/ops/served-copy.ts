// SPDX-License-Identifier: AGPL-3.0-only
//
// The copy of a validated release output that production serves (#497,
// promotion.ts): beside production's link, named by its digest, in a folder
// only the promoting user may write.

import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { outputDigest } from './build-output.ts';

// Where production's copies live, beside its link, each named by its digest.
const SERVED = 'served';

/**
 * The validated bytes, copied where production reads them: `served/` beside
 * production's link, a folder only the promoting user may write, holds a copy
 * named by their digest. It is copied whole under a temporary name, given no
 * group or other write, hashed, and renamed into place only if it holds that
 * digest. Production points here, so a write to the store, whoever makes it,
 * never changes what is served (#497). A copy already there counts only as a
 * real folder holding that digest.
 */
export function frozenCopy(
  selected: { readonly path: string; readonly name: string; readonly digest: string },
  current: string,
): { path: string } | { why: string } {
  const home = dirname(resolve(current));
  const folder = join(home, SERVED);
  if (!lexists(folder)) mkdirSync(folder, { mode: 0o755 });
  for (const at of [home, folder]) {
    const why = notPrivate(at);
    if (why !== undefined) return { why: `${at} ${why}` };
  }
  const path = join(folder, selected.digest.slice('sha256:'.length));
  if (!lexists(path)) {
    const copy = mkdtempSync(join(folder, '.copy-'));
    try {
      cpSync(selected.path, copy, { recursive: true, errorOnExist: true, force: false });
      withoutSharedWrite(copy);
      chmodSync(copy, lstatSync(selected.path).mode & 0o755);
      if (holds(copy, selected.digest)) renameSync(copy, path);
    } catch (error) {
      // Only another promotion of the same digest renaming its copy first.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
  return holds(path, selected.digest)
    ? { path }
    : { why: `${path} is not a real folder holding the bytes ${selected.name} records` };
}

/** Whether `copy` is a real folder of regular files holding `digest`. */
export function holds(copy: string, digest: string): boolean {
  try {
    return lstatSync(copy).isDirectory() && outputDigest(copy) === digest;
  } catch {
    // Gone, or a link or pipe inside it: not the bytes the check passed.
    return false;
  }
}

/** Why `path` is not a real folder that only this user may write, or undefined. */
function notPrivate(path: string): string | undefined {
  let entry;
  try {
    entry = lstatSync(path);
  } catch {
    return 'is missing';
  }
  if (!entry.isDirectory()) return 'is not a real folder';
  if (entry.uid !== process.getuid?.()) return 'belongs to another user';
  return (entry.mode & 0o022) === 0 ? undefined : 'can be written by others';
}

/** Takes group and other write off every folder and file under `root`, and `root`. */
function withoutSharedWrite(root: string): void {
  const entry = lstatSync(root);
  if (entry.isSymbolicLink()) return;
  chmodSync(root, entry.mode & 0o755);
  if (entry.isDirectory()) {
    for (const name of readdirSync(root)) withoutSharedWrite(join(root, name));
  }
}

/** Whether anything, a dangling link included, is at `path`. */
function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
