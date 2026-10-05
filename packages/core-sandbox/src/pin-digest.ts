// SPDX-License-Identifier: AGPL-3.0-only
//
// I4 (docs/plan/sandbox-contract.md, section 3). Stub.

import type { SiteEntry } from './pin-list.ts';
import type { SandboxResult } from './refusal.ts';

export function pinDigest(_packageJson: Uint8Array, _lockfile: Uint8Array): string {
  return '';
}

export function checkPin(
  _files: ReadonlyMap<string, Uint8Array>,
  _entry: SiteEntry,
): SandboxResult<object> {
  return { ok: true };
}
