// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-6-2's operational log claims to be append-only evidence: "a later read only
// adds rows after the drawn ones: nothing in a row depends on what happened
// after it" (`packages/ui/src/surfaces/agent/activity.tsx`). A row's job and
// title are looked up in the plan the read projects now, and the projection is
// the newest bound record on the task (`projectedPlan`; aw-06-planned-layer
// proves "the newest wins" on a real database). So a plan accepted later
// rewrites the rows already drawn for the events recorded under the first one.
//
// The plan, the graph and the pane are the real functions; the activity is
// built as `agent-pane.tsx`'s `useActivity` builds it: the graph's steps and
// the read's events.

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { projectedPlan } from '../../packages/core-runtime/src/index.ts';
import { payloadDigest } from '../../packages/core-digest/src/index.ts';
import { projectGraph } from '../../packages/core-commands/src/reads/execution-graph.ts';
import { lineage, pane, unmountAll } from './mp-6-1-agent-fixtures.tsx';

afterEach(unmountAll);

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** A plan record bound as the accept binds it (linked, one write, both digests). */
function bound(id: string, runId: string, steps: readonly { key: string; title: string }[]) {
  const record = { steps: steps.map((step) => ({ ...step, after: [] })) };
  const planText = `plan ${id}`;
  return {
    id,
    runId,
    record,
    recordDigest: payloadDigest(record),
    planText,
    textDigest: sha256(planText),
    linked: true,
    oneWrite: true,
  };
}

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

const event = (position: number, runId: string, kind: string, at: string) => ({
  eventId: `e-${String(position)}`,
  runId,
  position,
  kind,
  attemptId: `a-${String(position)}`,
  at,
});

const FIRST_PLAN = bound('plan-1', 'plan-run-1', [{ key: 'draft', title: 'Draft the reply' }]);
// The same task re-planned later: a newer bound record on another of its runs.
const SECOND_PLAN = bound('plan-2', 'plan-run-2', [
  { key: 'outline', title: 'Outline the reply' },
  { key: 'send', title: 'Send it to the client' },
]);

const FACTS = [
  runFacts('plan-run-1', 'plan-lineage-1', null),
  runFacts('run-1', 'work-lineage-1', 'draft'),
  runFacts('plan-run-2', 'plan-lineage-2', null),
  runFacts('run-2', 'work-lineage-2', 'send'),
];

/** One read: the projected plan from the candidates (newest first), its graph, its events. */
function activityOf(candidates: readonly unknown[], events: readonly ReturnType<typeof event>[]) {
  const graph = projectGraph(FACTS, projectedPlan(candidates), 1, true);
  return { steps: graph.steps, events };
}

const rows = (page: Awaited<ReturnType<typeof pane>>) => [
  ...(page.find('[data-agent="log"]')?.querySelectorAll('[data-log="row"]') ?? []),
];

describe('the operational log keeps its drawn rows when a newer plan is bound', () => {
  it('a row drawn under the first plan reads the same after the task is re-planned', async () => {
    const drafted = [
      event(1, 'run-1', 'claimed', '2026-09-30T10:00:00.000Z'),
      event(2, 'run-1', 'handed_back', '2026-09-30T10:42:00.000Z'),
    ];
    const before = rows(await pane({
      lineages: [lineage()],
      activity: activityOf([FIRST_PLAN], drafted),
    })).map((row) => row.outerHTML);
    expect(before).toHaveLength(2);
    expect(before[0]).toContain('JOB-01');
    expect(before[0]).toContain('Draft the reply');
    await unmountAll();

    // Later: the second plan is accepted (newest first, as PLAN_CANDIDATES
    // orders them) and its run records one more event.
    const later = [...drafted, event(3, 'run-2', 'claimed', '2026-09-30T11:05:00.000Z')];
    const after = rows(await pane({
      lineages: [lineage()],
      activity: activityOf([SECOND_PLAN, FIRST_PLAN], later),
    })).map((row) => row.outerHTML);
    expect(after).toHaveLength(3);
    expect(after.slice(0, before.length)).toStrictEqual(before);
  });
});
