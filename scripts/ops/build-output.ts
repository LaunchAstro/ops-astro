// SPDX-License-Identifier: AGPL-3.0-only
//
// The build output's Sydney check (ticket S0-6, `S0-6 functions in Sydney`).
// Not written yet: it refuses nothing.

/** Every reason the build output at `root` may not deploy; empty when it may. */
export function buildOutputProblems(_root: string): string[] {
  return [];
}
