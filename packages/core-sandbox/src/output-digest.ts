// SPDX-License-Identifier: AGPL-3.0-only
//
// Stub: O4's output digest (docs/plan/sandbox-contract.md, O4).

import type { TarEntry } from './ustar-reader.ts';

export function outputDigest(_entries: readonly TarEntry[]): string {
  return '';
}
