// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-3's held lines (#636). The look waits on the accepted prototype W4
// (#603, open: not yet drawn or tried by the owner). The width-and-theme
// harness (MP-1-7) came with batch 1, and the map page is on its report
// (mp-1-7-harness, mp-1-1-tokens); the match itself waits on W4. An
// agent's edit as a reviewable change waits on the agent credential narrowed
// from a person's grants (API-2, SL09 U18): until then `map.revise` is
// `agent: 'never'` and an agent is refused at the surface. Each line is its
// named test, a todo until then; the file is listed as deliberately unnamed in
// the database manifest, which refuses a skipped test in a named suite.

import { describe, it } from 'vitest';

describe('WF-3 held (LEANS-ON #603 W4, SL09 U18)', () => {
  it.todo('WF-3 visual match: the map view matches W4 at 1480, 900 and 390, light and dark');
  it.todo('WF-3 an agent’s edit shows as a reviewable change, not applied');
});
