// SPDX-License-Identifier: AGPL-3.0-only
//
// The made-up agent work behind the harness's answers (made-up-api.ts): the
// run and the run's receipt. The task's proposals at an armed gate and its
// ledger are in made-up-agent.ts, and the task rows themselves in
// made-up-rows.ts. Every name is made up. Test side only.

import type { ReceiptResult, TaskExecutionResult } from '../../packages/core-wire/src/index.ts';
import { DETAIL } from './made-up-rows.ts';

type Node = TaskExecutionResult['execution']['graph']['nodes'][number];

const OBSERVED: Node['observed'] = {
  condition: 'not_started',
  runState: 'planned',
  attemptId: null,
  whoseMove: null,
  outcome: null,
  fault: null,
  lease: null,
  effectObserved: false,
  heldMinor: null,
  spentMinor: null,
  currency: 'AUD',
};

const node = (
  nodeId: string,
  planned: Node['planned'],
  observed: Partial<Node['observed']>,
): Node => {
  const layer = { ...OBSERVED, ...observed };
  return { nodeId, condition: layer.condition, planned, observed: layer };
};

const GATHER = { key: 'gather', title: 'Gather the signed scope and both variations' };
const DRAFT = { key: 'draft', title: 'Draft the cover note for the review pack' };

// MP-6-3: T-1's bound plan, five steps in four depths. The first step's run
// settled and its gate was approved (made-up-agent.ts g-0), so the lines after
// it are satisfied; the draft's newest run waits at the armed gate (g-2) and
// is the inspector's preselection; the send waits on it and on the terms check.
const GRAPH: TaskExecutionResult['execution']['graph'] = {
  plan: 'bound',
  steps: [
    { ...GATHER, after: [], runIds: ['run-0'] },
    { key: 'terms', title: 'Check the renewal terms are dated', after: ['gather'], runIds: [] },
    { ...DRAFT, after: ['gather'], runIds: ['run-1', 'run-2'] },
    { key: 'send', title: 'Send the pack to the client', after: ['draft', 'terms'], runIds: [] },
    {
      key: 'file',
      title: 'File the signed pack on the client record',
      after: ['send'],
      runIds: [],
    },
  ],
  sourceRevision: 2,
  complete: true,
  nodes: [
    node('run-0', GATHER, {
      condition: 'settled',
      runState: 'handed_back',
      attemptId: 'a-0',
      outcome: 'completed',
      effectObserved: true,
      spentMinor: 5_400,
    }),
    node('run-1', DRAFT, { condition: 'superseded', runState: 'planned' }),
    node('run-2', DRAFT, { heldMinor: 12_000 }),
  ],
};

// An earlier version of the same lineage was approved and ran: one run whose
// attempt has a receipt, so the Agent perspective draws the mockup's receipt
// box (states.json `receipt`).
export const EXECUTION: TaskExecutionResult = {
  execution: {
    taskId: DETAIL.id,
    sourceRevision: 2,
    outcome: 'ready',
    runs: [
      {
        runId: 'r-1',
        lineageId: 'l-1',
        versionId: 'v-1',
        state: 'completed',
        taskRevisionAtRequest: 1,
        createdAt: '2026-09-25T05:00:00.000Z',
      },
    ],
    events: [
      {
        eventId: 'e-1',
        runId: 'r-1',
        position: 1,
        kind: 'claimed',
        attemptId: 'a-1',
        at: '2026-09-25T05:00:00.000Z',
      },
      {
        eventId: 'e-2',
        runId: 'r-1',
        position: 2,
        kind: 'effect_observed',
        attemptId: 'a-1',
        at: '2026-09-25T05:02:00.000Z',
      },
    ],
    complete: true,
    next: null,
    graph: GRAPH,
    plans: [],
  },
};

export const RECEIPT: ReceiptResult = {
  receipt: {
    attemptId: 'a-1',
    decision: { id: 'd-1' },
    version: { id: 'v-1', number: 1 },
    effect: { kind: 'comment', audience: 'internal' },
    settlement: { state: 'settled', heldMinor: 12_000, spentMinor: 9_500, releasedMinor: 2_500 },
  },
};
