// SPDX-License-Identifier: AGPL-3.0-only
//
// I3 (docs/plan/sandbox-contract.md, section 3): the input tree the launcher
// assembles from git objects at `baseRevision` (I2) is refused unless it is
// at most 20,000 entries and 50 MB of regular files and directories, every
// name in O1's character set plus `[` and `]`, NFC, unique after ASCII case
// folding, with no build output or tool directory and no package manager or
// git configuration file at any depth.

import type { SandboxResult } from './refusal.ts';

/** One entry of a git tree listing: its full path, git mode and blob size. */
export type TreeEntry = {
  readonly path: string;
  readonly mode: string;
  readonly size: number;
};

/** Stub: accepts every tree until I3 is built. */
export function checkTree(_entries: readonly TreeEntry[]): SandboxResult<object> {
  return { ok: true };
}
