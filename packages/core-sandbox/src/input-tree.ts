// SPDX-License-Identifier: AGPL-3.0-only
//
// I3 (docs/plan/sandbox-contract.md, section 3): the input tree the launcher
// assembles from git objects at `baseRevision` (I2) is refused unless it is
// at most 20,000 entries and 50 MB of regular files and directories, every
// name in O1's character set plus `[` and `]`, NFC, unique after ASCII case
// folding, with no build output or tool directory and no package manager or
// git configuration file at any depth. The character set is ASCII only, so
// every accepted name is NFC by construction.

import type { Refused, SandboxResult, Why } from './refusal.ts';

/** One entry of a git tree listing: its full path, git mode and blob size. */
export type TreeEntry = {
  readonly path: string;
  readonly mode: string;
  readonly size: number;
};

const MAX_ENTRIES = 20_000;
const MAX_BYTES = 50_000_000;
/** Git's modes for a regular file (plain or executable) and a directory. */
const MODES: ReadonlySet<string> = new Set(['100644', '100755', '040000']);
const SEGMENT = /^[A-Za-z0-9._~@+\-[\]]+$/u;
const RESERVED: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  '.astro',
  '.vercel',
  '.netlify',
]);
const CONFIG: ReadonlySet<string> = new Set([
  '.gitattributes',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.pnpmfile.cjs',
]);

const refusal = (why: Why): Refused => ({ ok: false, reason: 'input refused', why });

/** The clause a name breaks, or null when every segment is plain, allowed and not reserved. */
function nameClause(path: string): Why | null {
  const segments = path.split('/');
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment === '.' || segment === '..') return 'tree name';
  }
  if (segments.some((segment) => RESERVED.has(segment))) return 'tree reserved';
  if (segments.some((segment) => CONFIG.has(segment))) return 'tree config';
  return null;
}

export function checkTree(entries: readonly TreeEntry[]): SandboxResult<object> {
  if (entries.length > MAX_ENTRIES) return refusal('tree entries');
  const folded = new Set<string>();
  let bytes = 0;
  for (const entry of entries) {
    if (!MODES.has(entry.mode)) return refusal('tree type');
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) return refusal('tree size');
    bytes += entry.size;
    if (bytes > MAX_BYTES) return refusal('tree size');
    const clause = nameClause(entry.path);
    if (clause !== null) return refusal(clause);
    const key = entry.path.toLowerCase();
    if (folded.has(key)) return refusal('tree duplicate');
    folded.add(key);
  }
  return { ok: true };
}
