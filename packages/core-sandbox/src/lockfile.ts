// SPDX-License-Identifier: AGPL-3.0-only
//
// I5 (docs/plan/sandbox-contract.md, section 3): `site.prepare` accepts only
// a `package-lock.json` with `lockfileVersion` 3 and a `package.json` with no
// `packageManager` field. Every non-root package entry has a `sha512`
// integrity and a `resolved` URL of exactly one of two forms, built from the
// entry's own name and version; an alias, a link or any other host is a
// refusal.

import type { SandboxResult } from './refusal.ts';

/** Stub: accepts every lockfile until I5 is built. */
export function checkLockfile(
  _packageJson: string,
  _lockfile: string,
  _scopes: readonly string[],
): SandboxResult<object> {
  return { ok: true };
}
