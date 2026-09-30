// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-11 (#822): "an unplanned child step is shown". A helper's steps are model
// calls on the parent's lease, which carry no plan key, so each takes its
// parent run's placement on the graph (ORCH42's decision (a)): the parent's
// plan step, or unplanned, exactly as the parent node reads. The projection
// is `projectGraph`, fed the facts `execution.ts` reads.

import { describe, expect, it } from 'vitest';
import {
  projectGraph,
  type GraphPlan,
} from '../../packages/core-commands/src/reads/execution-graph.ts';

const PLAN: GraphPlan = {
  planRecordId: 'plan-record',
  runId: 'plan-run',
  steps: [{ key: 'draft', title: 'Draft the brief', after: [] }],
};

const callFacts = (callId: string) => ({
  callId,
  operation: 'model.replay_compose',
  state: 'settled',
  reservedMinor: 10,
  spentMinor: 4,
});

/** One run's facts, with one helper that made two calls on its lease. */
function runFacts(runId: string, lineageId: string, planStepKey: string | null) {
  return {
    runId,
    lineageId,
    state: 'in_progress',
    planStepKey,
    superseded: false,
    gateState: 'approved',
    currency: 'AUD',
    lease: null,
    attempt: null,
    effectObserved: false,
    heldMinor: 100,
    spentMinor: null,
    lastKind: null,
    lastFault: null,
    helpers: [
      {
        childDelegationId: `${runId}-child`,
        helperActorId: 'helper',
        expired: false,
        revoked: false,
        cause: null,
        outcome: null,
        refusal: null,
        steps: [callFacts(`${runId}-call-1`), callFacts(`${runId}-call-2`)],
      },
    ],
  };
}

const FACTS = [
  runFacts('plan-run', 'plan-lineage', null),
  runFacts('planned-run', 'other-lineage', 'draft'),
  runFacts('keyless-run', 'third-lineage', null),
  runFacts('stray-run', 'fourth-lineage', 'publish'),
];

function placementsOf(plan: GraphPlan | null) {
  const graph = projectGraph(FACTS, plan, 1, true);
  return Object.fromEntries(
    graph.nodes.map((node) => [
      node.nodeId,
      {
        node: { planned: node.planned, unplanned: node.condition === 'unplanned' },
        steps: node.helpers.flatMap((helper) =>
          helper.steps.map((step) => ({ planned: step.planned, unplanned: step.unplanned })),
        ),
      },
    ]),
  );
}

describe('AW-11 an unplanned child step is shown', () => {
  it('AW-11 an unplanned child step is shown: a helper’s steps take their parent run’s placement under a bound plan', () => {
    const placed = placementsOf(PLAN);
    const draft = { key: 'draft', title: 'Draft the brief' };
    expect(placed['planned-run']?.steps).toStrictEqual([
      { planned: draft, unplanned: false },
      { planned: draft, unplanned: false },
    ]);
    // A run naming no step, or a step the plan lacks, is unplanned, and so is
    // every step its helper took.
    for (const runId of ['keyless-run', 'stray-run']) {
      expect(placed[runId]?.steps, runId).toStrictEqual([
        { planned: null, unplanned: true },
        { planned: null, unplanned: true },
      ]);
    }
    // The plan's own run is the plan, and so are its helper's steps.
    expect(placed['plan-run']?.steps).toStrictEqual([
      { planned: null, unplanned: false },
      { planned: null, unplanned: false },
    ]);
    // Exactly as the parent node reads, run by run.
    for (const [runId, one] of Object.entries(placed)) {
      for (const step of one.steps) expect(step, runId).toStrictEqual(one.node);
    }
  });

  it('AW-11 an unplanned child step is shown: with no bound plan no helper step is called unplanned', () => {
    for (const [runId, one] of Object.entries(placementsOf(null))) {
      expect(one.node, runId).toStrictEqual({ planned: null, unplanned: false });
      for (const step of one.steps) expect(step, runId).toStrictEqual(one.node);
    }
  });
});
