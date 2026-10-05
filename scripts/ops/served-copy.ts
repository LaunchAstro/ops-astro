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
// a network share or a volume that ignores ownership, and no file flag
// (`uchg`, `uappnd` or their system forms) may sit on the link's folder, the
// link or anything at its swap name `<link>.promoting`, since each stops the
// swap after the migration. That is the boundary's stated limit (OPS497ACL),
// not something the walk proves.

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
  type Stats,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { outputDigest } from './build-output.ts';

// Where production's copies live, beside its link, each named by its digest.
const SERVED = 'served';

/**
 * The validated bytes, copied where production reads them: `served/` beside
 * production's link `link` (absolute and normalised), a folder only the
 * promoting user may write, holds a copy named by their digest. Each promotion
 * copies them whole under a temporary name that only the promoter can enter,
 * gives every entry inside its served mode (folders 0755, files 0644, or 0755
 * if they run) whatever the umask, and only then opens the copy itself. It is
 * hashed and renamed into place only if it holds that digest. Whatever was at
 * that name before is replaced, never served: an earlier copy's modes and
 * files are not this copy's. Inside the trust boundary a write to the store,
 * whoever makes it, never changes what is served (#497).
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
  if (!lexists(folder)) mkdirSync(folder, { mode: 0o700 });
  const why = untrustedFolder(folder, uid);
  if (why !== undefined) return { why: `${folder} ${why}` };
  if (!writable(folder)) return { why: `${folder} cannot be written by the promoter` };
  // The services read the copies as another user; the promoter owns served/ or is root.
  chmodSync(folder, 0o755);
  const blocked = swapBlocked(link);
  if (blocked !== undefined) return { why: blocked };
  const path = join(folder, selected.digest.slice('sha256:'.length));
  const made: string[] = [];
  try {
    const copy = mkdtempSync(join(folder, '.copy-'));
    made.push(copy);
    cpSync(selected.path, copy, { recursive: true, errorOnExist: true, force: false });
    servedModes(copy, uid);
    if (!holds(copy, selected.digest))
      return { why: `${selected.name} changed while it was copied` };
    const kept = replaced(path, copy, made, uid);
    return kept === undefined ? { path } : { why: kept };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    return holds(selected.path, selected.digest)
      ? { why: `${selected.name} could not be copied: ${failure.code ?? failure.message}` }
      : { why: `${selected.name} changed while it was copied` };
  } finally {
    for (const left of made) removed(left);
  }
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

/**
 * Sets the served modes on every folder and file under `root`, and `root`,
 * each folder only after everything in it: folders 0755, files 0644, or 0755
 * for a file with any execute bit. A folder stays as closed as it was made
 * until its entries are set. Links are left for the digest check to refuse.
 * Throws for an entry that is not the promoter's.
 */
function servedModes(root: string, uid: number | undefined): void {
  const entry = lstatSync(root);
  if (uid !== undefined && entry.uid !== uid) throw new Error(`${root} is not the promoter's`);
  if (entry.isSymbolicLink()) return;
  if (!entry.isDirectory()) {
    chmodSync(root, (entry.mode & 0o111) === 0 ? 0o644 : 0o755);
    return;
  }
  for (const name of readdirSync(root)) servedModes(join(root, name), uid);
  chmodSync(root, 0o755);
}

/**
 * Puts the checked `copy` at `path` in served/, moving anything there before
 * aside into a temporary folder it adds to `made`; why not, or undefined. A
 * copy that cannot take the name puts the earlier one back, so a failed
 * promotion changes nothing served.
 */
function replaced(
  path: string,
  copy: string,
  made: string[],
  uid: number | undefined,
): string | undefined {
  const before = mkdtempSync(join(dirname(path), '.before-'));
  made.push(before);
  const earlier = join(before, 'copy');
  const entry = lexists(path) ? lstatSync(path) : undefined;
  if (entry !== undefined) {
    const kept = unmovable(path, entry, uid);
    if (kept !== undefined) return kept;
    renameSync(path, earlier);
  }
  try {
    renameSync(copy, path);
  } catch (error) {
    // If the put-back fails too, the earlier copy goes with the temporary
    // folder; one promotion at a time (the runbook) leaves no one to take the name.
    if (lexists(earlier) && !lexists(path)) {
      renameSync(earlier, path);
      // Its own modes again, so the release production still points at reads as before.
      if (entry?.isDirectory() === true) chmodSync(path, entry.mode & 0o7777);
    }
    throw error;
  }
  return undefined;
}

/**
 * Why the promoter cannot move `path` aside, or undefined. A folder moves only
 * with write on itself: one the promoter owns (or any, for root) is given it,
 * in served/, which only the promoter writes; another user's is refused.
 */
function unmovable(path: string, entry: Stats, uid: number | undefined): string | undefined {
  if (!entry.isDirectory()) return undefined;
  if (uid !== undefined && uid !== 0 && entry.uid !== uid) {
    return `${path} is there and is not the promoter's, so it cannot be replaced`;
  }
  chmodSync(path, 0o700);
  return undefined;
}

/** Removes the temporary folder `path`; a failure leaves it, said, and changes no answer. */
function removed(path: string): void {
  try {
    // A copy of a folder without owner write cannot be emptied until it has it.
    if (lexists(path)) ownerWrites(path);
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    process.stderr.write(`served-copy: left ${path}: ${(error as Error).message}\n`);
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

/**
 * Gives every real folder under `root`, and `root`, mode 0700, so it can be
 * removed. It walks by path: inside served/ every entry is the promoter's, so
 * none can turn into a link under it. An earlier copy holding another user's
 * folder could only come from outside the trust boundary (OPS497ACL).
 */
function ownerWrites(root: string): void {
  const entry = lstatSync(root);
  if (!entry.isDirectory()) return;
  chmodSync(root, 0o700);
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
