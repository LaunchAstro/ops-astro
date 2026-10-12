// SPDX-License-Identifier: AGPL-3.0-only
//
// A plan accepted on a run of an already planned lineage is that run's own
// plan. The older plan the run was proposed under reaches it through the
// lineage, but the run's exact match wins, so its events sit in the newer
// plan and that plan is among the plans the read returns.

import { describe, expect, it } from 'vitest';
import { placeEvents } from '../../packages/core-commands/src/reads/execution-placement.ts';

const plan = (planRecordId: string, runId: string) => ({
  planRecordId,
  runId,
  steps: [{ key: 'draft', title: `Draft under ${planRecordId}`, after: [] }],
});

describe('Placement: a revised plan on a successor run', () => {
  it('places the successor run in the plan accepted on it, not the older lineage plan', () => {
    // P1 accepted on R1; R2 proposed on R1's lineage; P2 accepted on R2.
    const facts = [
      { runId: 'R1', lineageId: 'L', planStepKey: null, boundBefore: [] },
      { runId: 'R2', lineageId: 'L', planStepKey: null, boundBefore: ['P1'] },
    ];
    const placed = placeEvents(facts, [plan('P2', 'R2'), plan('P1', 'R1')], [{ runId: 'R2' }]);
    expect(placed.events).toEqual([
      { runId: 'R2', placement: { planRecordId: 'P2', stepKey: null, planRun: true } },
    ]);
    expect(placed.plans.map((each) => each.planRecordId)).toContain('P2');
  });
});
