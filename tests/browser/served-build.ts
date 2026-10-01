// SPDX-License-Identifier: AGPL-3.0-only
//
// The rule a browser row applies to the build that served it (S0-1, line C8;
// product issue 57).
//
// A row that ran through the application's own modules is evidence about those
// modules only if it says which build they were. The page shows its stamp in
// the rail, the served entry document carries it in a `<meta>`, and the row
// knows the stamp it expected: the checkout's, or `EXPECT_BUILD` for a run
// against a built artefact. All three must be present and equal. A page with
// no stamp is red, not skipped, because an unstamped page is exactly the case
// in which nobody can say what was tested.
//
// Pure, so a required check can hold it; `harness.mjs` does the reading.

import { STAMP_META, STAMP_SHAPE } from '../../apps/web/build-stamp.ts';

/** The stamp's one fixed place in the page template (`Shell.tsx`). */
export const BUILD_SELECTOR = '.rail__build[data-build]';

export interface ServedBuildVerdict {
  readonly ok: boolean;
  /** The line the row prints beside its `served` lines. */
  readonly line: string;
}

/** The stamp a served entry document carries, if it carries a well-formed one. */
export function stampInDocument(html: string): string | undefined {
  const tag = new RegExp(`<meta\\s+name="${STAMP_META}"\\s+content="([^"]*)"`, 'u').exec(html);
  const stamp = tag?.[1];
  return stamp !== undefined && STAMP_SHAPE.test(stamp) ? stamp : undefined;
}

export function servedBuildVerdict(given: {
  readonly label: string;
  readonly shown: string | null | undefined;
  readonly entry: string | undefined;
  readonly expected: string | undefined;
}): ServedBuildVerdict {
  const shown = given.shown ?? '';
  const entry = given.entry ?? '';
  const expected = given.expected ?? '';
  const said = `served ${given.label} build page=${shown || 'none'} entry=${entry || 'none'} expected=${expected || 'none'}`;
  if (shown === '' || entry === '' || expected === '') {
    return { ok: false, line: `${said} no stamp` };
  }
  const ok = shown === expected && entry === expected;
  return { ok, line: `${said} ${ok ? 'match' : 'MISMATCH'}` };
}
