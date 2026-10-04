// SPDX-License-Identifier: AGPL-3.0-only
//
// Whether a test that reads the built web bundle must build it first.

/** True when `dist` must be rebuilt before a test reads it as the tree `identifier` names. */
export function needsBuild(_dist: string, _identifier: string): boolean {
  return true;
}
