// SPDX-License-Identifier: AGPL-3.0-only
//
// U39's two cost tickets, held until their ledger lands (BUILD-AHEAD-B3
// rule 2). Skill costing (MP-14-9, #492) reads the per-run token ledger
// (MP-6-5, SL12's U34) grouped by the definition version each run names
// (AW-02's reference slot on a run); What our agents cost us (MP-14-6, #489)
// reads the same ledger per agent and per client on the page kit (MP-9-1).
// Each case is written in full, red first, once its dependency is on the
// branch; the width-and-theme captures wait on MP-1-7.

import { describe, it } from 'vitest';

describe('MP-14-9 skill costing, held on MP-6-5 and AW-02', () => {
  it.todo(
    'MP-14-9 owner check: skill costing shows each skill’s cost, and its process document link is drawn unavailable with its reason until Docs exists',
  );
  it.todo('MP-14-9 the section is absent when nothing has run');
  it.todo('MP-14-9 three figure branches: mean with spread, one run, none');
  it.todo('MP-14-9 attribution buckets add back to the total');
  it.todo(
    'MP-14-9 skill names carry the process document’s canonical Docs address, drawn unavailable with their reason until Docs exists',
  );
  it.todo('MP-14-9 section numbers read top to bottom; skill costing is 009 (R61)');
  it.todo(
    'MP-14-9 isolation: another business, another client in the same business and an agent under a live delegation see no cost of these skills',
  );
  it.todo('MP-14-9 harness captures at 1480, 900 and 390, light and dark (MP-1-7)');
});

describe('MP-14-6 what our agents cost us, held on MP-6-5 and MP-9-1', () => {
  it.todo('MP-14-6 owner check: spend per agent and per client shows for the period');
  it.todo('MP-14-6 exact model ids wrap and never truncate');
  it.todo('MP-14-6 unpriced runs say so');
  it.todo('MP-14-6 attachment falls back to "the agency"');
  it.todo('MP-14-6 the cost log folds at 8 rows with "Show n more", as the book does (CS-14.10)');
  it.todo('MP-14-6 internal face only');
  it.todo(
    'MP-14-6 isolation: another business, another client in the same business and an agent under a live delegation see no spend of these agents',
  );
  it.todo('MP-14-6 harness captures at 1480, 900 and 390, light and dark (MP-1-7)');
});
