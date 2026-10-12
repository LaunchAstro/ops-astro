// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04: the instruction root the plan accept reads from.
//
// The server holds the instruction files in one read-only directory, named on
// the process by `OPS_ASTRO_INSTRUCTION_ROOT`; no caller supplies bytes or a
// root. A path is a plain relative name inside it (`isInstructionPath`). Every
// segment is looked at without following links, so a symlink anywhere on the
// way, a name that resolves outside the root, a directory and a missing file
// all read as nothing, which the manifest capture answers
// `DEFINITION_UNAVAILABLE`; the root itself unreachable is the store down, the
// same code naming the fault as ours (`storeUnavailable`). The file is opened
// without following a link and read once, through the handle that was checked:
// it must be the file the segment checks found, and the path, checked again,
// must still name it. The root may be `/`.
//
// C33's `definition_version` replaces this source when it is built: runs then
// pin a definition version in the same slot (`0192_bootstrap_pins`), and the
// directory goes.

import { constants, type Stats } from 'node:fs';
import { access, lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isInstructionPath, type InstructionSource } from './definitions.ts';

export const INSTRUCTION_ROOT_VARIABLE = 'OPS_ASTRO_INSTRUCTION_ROOT';

/** The file `path` names under `root` when every segment is a directory or, last, a plain file. */
async function plainSegments(root: string, path: string): Promise<Stats | undefined> {
  const segments = path.split('/');
  let at = root;
  for (const [index, segment] of segments.entries()) {
    at = join(at, segment);
    // Sequential: each segment is checked before the next is named.
    // eslint-disable-next-line no-await-in-loop
    const found = await lstat(at);
    const last = index === segments.length - 1;
    if (last) return found.isFile() ? found : undefined;
    if (!found.isDirectory()) return undefined;
  }
  return undefined;
}

const same = (one: Stats | undefined, other: Stats): boolean =>
  one !== undefined && one.dev === other.dev && one.ino === other.ino;

async function readInside(root: string, path: string): Promise<Uint8Array | undefined> {
  if (!isInstructionPath(path)) return undefined;
  try {
    const base = await realpath(root);
    const checked = await plainSegments(base, path);
    if (checked === undefined) return undefined;
    const handle = await open(join(base, path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      // A directory on the way swapped for a link while the file opened: what opened is the
      // file the checks found, and the path still names it once checked again.
      const opened = await handle.stat();
      if (!same(checked, opened) || !same(await plainSegments(base, path), opened)) {
        return undefined;
      }
      return new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** Whether `root` is a directory this process can list and read, now. */
async function reachable(root: string): Promise<boolean> {
  try {
    const at = await realpath(root);
    await access(at, constants.R_OK | constants.X_OK);
    return (await lstat(at)).isDirectory();
  } catch {
    return false;
  }
}

/** The files under `root`, read-only. */
export function directorySource(root: string): InstructionSource {
  return {
    read: async (path) => await readInside(root, path),
    available: async () => await reachable(root),
  };
}

/** The process's instruction root, or `undefined` when none is configured (or it is not absolute). */
export function configuredInstructionSource(
  env: Readonly<Record<string, string | undefined>> = process.env,
): InstructionSource | undefined {
  const root = env[INSTRUCTION_ROOT_VARIABLE] ?? '';
  return root !== '' && isAbsolute(root) ? directorySource(root) : undefined;
}
