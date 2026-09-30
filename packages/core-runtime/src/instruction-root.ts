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
// `DEFINITION_UNAVAILABLE`. The file is opened without following a link and
// read once, through the handle that was checked.
//
// C33's `definition_version` replaces this source when it is built: runs then
// pin a definition version in the same slot (`0043_bootstrap_pins`), and the
// directory goes.

import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { isInstructionPath, type InstructionSource } from './definitions.ts';

export const INSTRUCTION_ROOT_VARIABLE = 'OPS_ASTRO_INSTRUCTION_ROOT';

/** Whether every segment of `path` under `root` is a directory or, last, a plain file. */
async function plainSegments(root: string, path: string): Promise<boolean> {
  const segments = path.split('/');
  let at = root;
  for (const [index, segment] of segments.entries()) {
    at = join(at, segment);
    // Sequential: each segment is checked before the next is named.
    // eslint-disable-next-line no-await-in-loop
    const found = await lstat(at);
    const last = index === segments.length - 1;
    if (last ? !found.isFile() : !found.isDirectory()) return false;
  }
  return true;
}

async function readInside(root: string, path: string): Promise<Uint8Array | undefined> {
  if (!isInstructionPath(path)) return undefined;
  try {
    const base = await realpath(root);
    if (!(await plainSegments(base, path))) return undefined;
    const full = join(base, path);
    if (!(await realpath(full)).startsWith(base + sep)) return undefined;
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) return undefined;
      return new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** The files under `root`, read-only. */
export function directorySource(root: string): InstructionSource {
  return { read: async (path) => await readInside(root, path) };
}

/** The process's instruction root, or `undefined` when none is configured (or it is not absolute). */
export function configuredInstructionSource(
  env: Readonly<Record<string, string | undefined>> = process.env,
): InstructionSource | undefined {
  const root = env[INSTRUCTION_ROOT_VARIABLE] ?? '';
  return root !== '' && isAbsolute(root) ? directorySource(root) : undefined;
}
