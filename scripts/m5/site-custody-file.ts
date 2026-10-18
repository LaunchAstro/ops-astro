// SPDX-License-Identifier: AGPL-3.0-only
//
// The site's owner-only credential file on the M5 (#1691, #1793): opened
// without following a link, read only when it is this user's plain file of
// mode 0600, and changed only under its lock, written whole and read back.
// Nothing here prints or returns a value: a refusal names a code.

import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { publishSecret } from '../../apps/cli/secret-file.ts';
import { parseCredentials } from '../../packages/core-custody/src/index.ts';

export type Refusal = `refused ${string}`;

/**
 * The file, opened without following a link, if it is a plain file of this
 * user's that no one else can read: its descriptor, `absent`, or why it is
 * refused. Nothing of its contents is read here.
 */
export function openOwnerOnly(file: string): number | 'absent' | Refusal {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'absent';
    return code === 'ELOOP' ? 'refused LOAD_FILE_NOT_OWNER_ONLY' : 'refused LOAD_FILE_UNREADABLE';
  }
  const stat = fstatSync(fd);
  if (stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600) return fd;
  closeSync(fd);
  return 'refused LOAD_FILE_NOT_OWNER_ONLY';
}

/** The owner-only file's entries, none when it is absent, refused unless custody would load them. */
function entriesIn(file: string): unknown[] | Refusal {
  const fd = openOwnerOnly(file);
  if (fd === 'absent') return [];
  if (typeof fd === 'string') return fd;
  try {
    const entries: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    const parsed = parseCredentials(entries);
    return parsed.ok ? (entries as unknown[]) : `refused ${parsed.code}`;
  } catch {
    return 'refused LOAD_FILE_UNREADABLE';
  } finally {
    closeSync(fd);
  }
}

/**
 * One change to the credential file under its lock: `change` answers the
 * entries to write and the one entry they must read back with, `unchanged`
 * when the file already holds it, or a refusal. Written whole, then read back.
 */
export function changeUnderLock(
  file: string,
  change: (entries: unknown[]) => { entries: unknown[]; filed: unknown } | 'unchanged' | Refusal,
): 'done' | 'unchanged' | Refusal {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  let held: number;
  try {
    held = openSync(lock, 'wx', 0o600);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code === 'EEXIST' ? 'refused LOAD_IN_PROGRESS' : 'refused LOAD_FILE_UNREADABLE';
  }
  try {
    const entries = entriesIn(file);
    if (typeof entries === 'string') return entries;
    const changed = change(entries);
    if (typeof changed === 'string') return changed;
    const next = parseCredentials(changed.entries);
    if (!next.ok) return `refused ${next.code}`;
    publishSecret(file, JSON.stringify(changed.entries));
    const back = entriesIn(file);
    const readBack =
      typeof back !== 'string' && back.some((one) => isDeepStrictEqual(one, changed.filed));
    return readBack ? 'done' : 'refused LOAD_NOT_READ_BACK';
  } finally {
    closeSync(held);
    rmSync(lock, { force: true });
  }
}

export const refOf = (one: unknown): unknown => (one as { ref?: unknown }).ref;

/** Files `filed` once: the same entry again changes nothing, another under its name is refused. */
export function fileOnce(
  file: string,
  filed: Readonly<Record<string, unknown>> & { readonly ref: string },
): 'loaded' | 'already loaded' | Refusal {
  const outcome = changeUnderLock(file, (entries) => {
    const loaded = entries.find((one) => refOf(one) === filed.ref);
    if (loaded === undefined) return { entries: [...entries, filed], filed };
    return isDeepStrictEqual(loaded, filed) ? 'unchanged' : 'refused ENTRY_ALREADY_LOADED';
  });
  return outcome === 'done' ? 'loaded' : outcome === 'unchanged' ? 'already loaded' : outcome;
}
