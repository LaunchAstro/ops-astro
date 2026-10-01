// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// AW-06's graph rules that "the plan's own run, and the runs of its lineage,
// are the plan, not work outside it" (`execution-graph.ts`): their nodes are
// never `unplanned`. MP-6-2's operational log decides "Outside the plan" from
// the steps' run lists alone, which never hold the plan's own run, so the
// events of the run the plan was made and accepted on are logged as outside
// the plan the graph says they are.
//
// The graph and the pane are the real functions; the activity is built as
// `agent-pane.tsx`'s `useActivity` builds it: the graph's steps and the events.

import { afterEach, describe, expect, it } from 'vitest';
import {
  projectGraph,
  type GraphPlan,
} from '../../packages/core-commands/src/reads/execution-graph.ts';
import { lineage, pane, unmountAll } from './mp-6-1-agent-fixtures.tsx';

afterEach(unmountAll);

const PLAN: GraphPlan = {
  planRecordId: 'plan-record',
  runId: 'plan-run',
  steps: [{ key: 'draft', title: 'Draft the reply', after: [] }],
};

function runFacts(runId: string, lineageId: string, planStepKey: string | null) {
  return {
    runId,
    lineageId,
    state: 'handed_back',
    planStepKey,
    superseded: false,
    gateState: 'approved',
    currency: 'AUD',
    lease: null,
    attempt: null,
    effectObserved: false,
    heldMinor: null,
    spentMinor: null,
    lastKind: 'handed_back',
    lastFault: null,
    definition: null,
    helpers: [],
  };
}

const FACTS = [runFacts('plan-run', 'plan-lineage', null), runFacts('run-1', 'work', 'draft')];

describe('the operational log places the plan run as the graph does', () => {
  it("the plan's own run, which the graph never calls unplanned, is not logged outside the plan", async () => {
    const graph = projectGraph(FACTS, PLAN, 1, true);
    const planNode = graph.nodes.find((node) => node.nodeId === 'plan-run');
    // The graph's ruling, at this head.
    expect(planNode?.condition).not.toBe('unplanned');

    const page = await pane({
      lineages: [lineage()],
      activity: {
        steps: graph.steps,
        events: [
          {
            eventId: 'e-1',
            runId: 'plan-run',
            position: 1,
            kind: 'claimed',
            attemptId: 'a-1',
            at: '2026-09-30T09:00:00.000Z',
          },
        ],
      },
    });
    const row = page.find('[data-agent="log"] [data-log="row"]');
    expect(row?.querySelector('[data-log="job"]')?.textContent).not.toBe('Outside the plan');
  });
});
