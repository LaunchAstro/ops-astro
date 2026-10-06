// SPDX-License-Identifier: AGPL-3.0-only
//
// I4 (docs/plan/sandbox-contract.md, section 3): the pin is refused unless
// the digest of `package.json` and `package-lock.json` together, at the
// root of the tree as built, equals the site entry's lockfile digest. The
// digest is the sha256 of each file's length (8 bytes, big-endian) and
// bytes, `package.json` first, so no bytes can move from one file to the
// other unseen. A site entry with no image id (a pin being made, B8) is
// refused `no pin` before the digest is read.

import { createHash } from 'node:crypto';
import { length8 } from './output-digest.ts';
import type { SiteEntry } from './pin-list.ts';
import type { SandboxResult } from './refusal.ts';

/** The lockfile digest of a manifest pair, as the pin list spells it. */
export function pinDigest(packageJson: Uint8Array, lockfile: Uint8Array): string {
  const hash = createHash('sha256');
  for (const file of [packageJson, lockfile]) hash.update(length8(file.length)).update(file);
  return `sha256:${hash.digest('hex')}`;
}

export function checkPin(
  files: ReadonlyMap<string, Uint8Array>,
  entry: SiteEntry,
): SandboxResult<object> {
  if (entry.image === '') return { ok: false, reason: 'no pin', why: 'pin image' };
  const packageJson = files.get('package.json');
  const lockfile = files.get('package-lock.json');
  if (
    packageJson === undefined ||
    lockfile === undefined ||
    pinDigest(packageJson, lockfile) !== entry.lockfile
  )
    return { ok: false, reason: 'pin mismatch', why: 'pin digest' };
  return { ok: true };
}
