// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-06: `task.execution` answers with the graph `projectGraph` draws, and the
// wire contract (`core-wire/src/views-run.ts`) is what a client reads it as.
// Under a bound plan the read draws planned nodes and calls a run outside
// the plan `unplanned`, so the contract must take that graph as it is. The
// assignment below is the contract check: the typecheck refuses it when the
// wire drops a condition or a field the read produces.

import { describe, expect, it } from 'vitest';
import {
  projectGraph,
  type GraphPlan,
} from '../../packages/core-commands/src/reads/execution-graph.ts';
import type { ExecutionGraph } from '../../packages/core-wire/src/index.ts';

const PLAN: GraphPlan = {
  planRecordId: 'plan-record',
  runId: 'plan-run',
  steps: [{ key: 'draft', title: 'Draft the brief', after: [] }],
};

function runFacts(runId: string, lineageId: string, planStepKey: string | null) {
  return {
    runId,
    lineageId,
    state: 'planned',
    planStepKey,
    superseded: false,
    gateState: 'approved',
    currency: 'AUD',
    lease: null,
    attempt: null,
    effectObserved: false,
    heldMinor: null,
    spentMinor: null,
    lastKind: null,
    lastFault: null,
    definition: null,
    helpers: [],
  };
}

const FACTS = [
  runFacts('plan-run', 'plan-lineage', null),
  runFacts('planned-run', 'other-lineage', 'draft'),
  runFacts('stray-run', 'third-lineage', null),
];

describe('the execution graph on the wire', () => {
  it('the wire graph takes a bound plan with a planned node and an unplanned one', () => {
    const wire: ExecutionGraph = projectGraph(FACTS, PLAN, 3, true);

    expect(wire.plan).toBe('bound');
    expect(wire.steps).toStrictEqual([
      { key: 'draft', title: 'Draft the brief', after: [], runIds: ['planned-run'] },
    ]);
    expect(
      wire.nodes.map((node) => ({
        id: node.nodeId,
        condition: node.condition,
        planned: node.planned,
        observed: node.observed.condition,
      })),
    ).toStrictEqual([
      { id: 'plan-run', condition: 'not_started', planned: null, observed: 'not_started' },
      {
        id: 'planned-run',
        condition: 'not_started',
        planned: { key: 'draft', title: 'Draft the brief' },
        observed: 'not_started',
      },
      { id: 'stray-run', condition: 'unplanned', planned: null, observed: 'not_started' },
    ]);
  });
});
