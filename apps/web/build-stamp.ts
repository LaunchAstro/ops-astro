// SPDX-License-Identifier: AGPL-3.0-only
// Red-first stub for S0-1c: the signatures only.

export const STAMP_FILE = 'build.json';
export const STAMP_META = 'ops-astro-build';

export function buildIdentifier(_cwd: string): string {
  throw new Error('build identifier: not built yet (S0-1c)');
}

export function readStamp(_directory: string): string | undefined {
  return undefined;
}
