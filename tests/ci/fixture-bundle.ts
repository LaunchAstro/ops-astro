// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b2 (T4-R3): no fixture path in the shipped bundle.
//
//   node tests/ci/fixture-bundle.ts [dist]     (default apps/web/dist)

export interface Hit {
  readonly file: string;
  readonly selector: string;
}

/** Every selector found in the built bundle at `dist`. Not built yet. */
export function scanBundle(_dist: string): readonly Hit[] {
  return [];
}
