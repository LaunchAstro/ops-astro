// SPDX-License-Identifier: AGPL-3.0-only
//
// The copy of a validated release output that production serves (#497,
// promotion.ts): beside production's link, named by its digest, in a folder
// only the promoting user may write.
//
// The trust boundary (OPS497TRUST) is root and the promoting user. Whoever can
// write any folder on the path to production's link can move the link's
// folder away and put their own in its place, so every folder from the link's
// up to `/` must be a real folder, owned by root or the promoter, with no group
// or other write and no sticky bit. A path that fails is refused, never
// repaired: the operator names a link under folders only they and root write.
// The check reads owners and mode bits, so it cannot see a write granted any
// other way: the path must carry no ACL that grants write, and must not be on
// a network share or a volume that ignores ownership, and production's link
// carries no immutable flag (`chflags uchg`, which stops its swap after the
// migration). That is the boundary's stated limit (OPS497ACL), not something
// the walk proves.

import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { outputDigest } from './build-output.ts';

// Where production's copies live, beside its link, each named by its digest.
const SERVED = 'served';

/**
 * The validated bytes, copied where production reads them: `served/` beside
 * production's link `link` (absolute and normalised), a folder only the
 * promoting user may write, holds a copy named by their digest. It is copied
 * whole under a temporary name, given no group or other write, hashed, and
 * renamed into place only if it holds that digest. Inside the trust boundary
 * a write to the store, whoever makes it, never changes what is served (#497).
 * A copy already there counts only as a real folder holding that digest.
 */
export function frozenCopy(
  selected: { readonly path: string; readonly name: string; readonly digest: string },
  link: string,
): { path: string } | { why: string } {
  const uid = process.getuid?.();
  const home = dirname(link);
  const untrusted = untrustedChain(home, uid);
  if (untrusted !== undefined) return { why: untrusted };
  if (!writable(home)) return { why: `${home} cannot be written by the promoter` };
  const folder = join(home, SERVED);
  if (!lexists(folder)) mkdirSync(folder, { mode: 0o755 });
  const why = untrustedFolder(folder, uid);
  if (why !== undefined) return { why: `${folder} ${why}` };
  if (!writable(folder)) return { why: `${folder} cannot be written by the promoter` };
  const blocked = swapBlocked(link);
  if (blocked !== undefined) return { why: blocked };
  const path = join(folder, selected.digest.slice('sha256:'.length));
  let failure: NodeJS.ErrnoException | undefined;
  if (!lexists(path)) {
    const copy = mkdtempSync(join(folder, '.copy-'));
    try {
      cpSync(selected.path, copy, { recursive: true, errorOnExist: true, force: false });
      withoutSharedWrite(copy);
      chmodSync(copy, lstatSync(selected.path).mode & 0o755);
      if (holds(copy, selected.digest)) renameSync(copy, path);
    } catch (error) {
      // Answered below: another promotion renaming its copy first is no
      // failure; otherwise the artefact changed, or the disk said why.
      failure = error as NodeJS.ErrnoException;
    } finally {
      // A copy of a folder without owner write cannot be emptied until it has it.
      if (lexists(copy)) ownerWrites(copy);
      rmSync(copy, { recursive: true, force: true });
    }
  }
  if (!lexists(path)) {
    return failure !== undefined && holds(selected.path, selected.digest)
      ? { why: `${selected.name} could not be copied: ${failure.code ?? failure.message}` }
      : { why: `${selected.name} changed while it was copied` };
  }
  return holds(path, selected.digest)
    ? { path }
    : { why: `${path} is not a real folder holding the bytes ${selected.name} records` };
}

/**
 * Why the folders from `home` (absolute and normalised) up to `/` are not all
 * trusted, or undefined: the first one that fails, and why.
 */
export function untrustedChain(home: string, uid: number | undefined): string | undefined {
  for (let at = home; ; at = dirname(at)) {
    const why = untrustedFolder(at, uid);
    if (why !== undefined) return `${at} ${why}`;
    if (dirname(at) === at) return undefined;
  }
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

/**
 * Why `path` is outside the trust boundary, or undefined. Only one shape is
 * trusted: a real folder, owned by root or `uid`, no sticky bit, no group or
 * other write. Anything else, a link included, is refused.
 */
function untrustedFolder(path: string, uid: number | undefined): string | undefined {
  let entry;
  try {
    entry = lstatSync(path);
  } catch {
    return 'is missing';
  }
  if (entry.isSymbolicLink()) return 'is a link; name the real path';
  if (!entry.isDirectory()) return 'is not a real folder';
  if (entry.uid !== 0 && entry.uid !== uid)
    return 'belongs to a user other than root and the promoter';
  if ((entry.mode & 0o1000) !== 0) return 'is shared like /tmp (sticky)';
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

/**
 * Why swapping `link` would fail after the migration, or undefined. Only a
 * link is swapped for the new one; anything else there, `served/` itself in
 * any letter case included, would stop the swap, and so would a folder at the
 * swap's own name (promote.mjs's `point`).
 */
function swapBlocked(link: string): string | undefined {
  if (lexists(link) && !lstatSync(link).isSymbolicLink())
    return `${link} is there and is not a link`;
  const next = `${link}.promoting`;
  if (lexists(next) && lstatSync(next).isDirectory()) {
    return `${next} is a folder; the link's swap needs that name`;
  }
  return undefined;
}

/** Whether this user may make entries in the folder `path`: write it and search it. */
function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Gives the owner full rights on every real folder under `root`, and `root`, so it can be removed. */
function ownerWrites(root: string): void {
  const entry = lstatSync(root);
  if (!entry.isDirectory()) return;
  chmodSync(root, entry.mode | 0o700);
  for (const name of readdirSync(root)) ownerWrites(join(root, name));
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
