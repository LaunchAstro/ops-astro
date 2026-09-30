// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13's pinned local trace target. Signature only: not built.

/** Every way the profile in `dir` drifts from its pin; empty when it holds. */
export function profileRefusals(_dir: string): readonly string[] {
  throw new Error('AW-13 pinned profile: not built');
}
