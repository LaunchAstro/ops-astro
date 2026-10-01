// SPDX-License-Identifier: AGPL-3.0-only
//
// The made-up rows behind the harness's answers (made-up-api.ts), following the
// pinned mockup's Projects board. Every name and client is made up. Test side only.

import type {
  InternalTaskDetail,
  ProposalView,
  ReceiptResult,
  TaskExecutionResult,
  TaskStateView,
  TaskSummary,
} from '../../packages/core-wire/src/index.ts';
import { MIA, NATHAN } from './made-up-access.ts';

const STATE = {
  active: { id: 's-active', key: 'active', label: 'Active', machineCategory: 'started' },
  waiting: {
    id: 's-waiting',
    key: 'waiting',
    label: 'Waiting on client',
    machineCategory: 'backlog',
  },
  hold: { id: 's-hold', key: 'hold', label: 'On hold', machineCategory: 'unstarted' },
} as const satisfies Record<string, TaskStateView>;

const task = (
  n: number,
  title: string,
  state: TaskStateView,
  due: string | null,
  assignee: TaskSummary['assignee'] = NATHAN,
): TaskSummary => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  key: `T-${String(n)}`,
  title,
  state,
  assignee,
  due,
  priority: null,
  completedAt: null,
  revision: 1,
});

// The harness clock is 2026-09-26; dates sit either side of it.
export const TASKS: readonly TaskSummary[] = [
  task(1, 'Contract review pack, 31 July', STATE.active, '2026-09-30'),
  task(6, 'Renewal pack, 14 August', STATE.active, '2026-10-07'),
  task(9, 'Sign off the Meridian ad run rate, 29% over budget', STATE.active, '2026-09-18'),
  task(13, 'Approve the four review replies before they go out', STATE.active, '2026-09-26'),
  task(15, 'Ads rebuild: cost per enquiry', STATE.active, '2026-10-06', MIA),
  task(17, 'Shopping feed clean-up', STATE.active, '2026-10-05'),
  task(24, 'New patient offer campaign', STATE.active, '2026-10-09'),
  task(4, 'Budget pacing fix', STATE.waiting, '2026-10-01', null),
  task(33, 'Paid social rebuild', STATE.hold, null),
];

// One proposal whose newest version waits at an armed gate, so the task page
// draws the mockup's gate box (states.json `gate`). The gate's deadline sits
// after the harness clock, so it reads pending and the controls are offered.
const DIGEST = 'sha256:7c41e8f9a2d6b3915e0c47a8fd23b6c1e94a7f80d5b2c6e31a94f7d2b8c05e4a2';
const PROPOSAL: ProposalView = {
  lineageId: 'l-1',
  state: 'live',
  versions: [
    {
      versionId: 'v-2',
      version: 2,
      purpose: 'contract_review_pack',
      maximumMinor: 12_000,
      currency: 'AUD',
      payloadDigest: DIGEST,
      payload: { pack: 'Signed scope, two variations and the renewal terms, in one PDF.' },
      supersededAt: null,
      runId: null,
      evidence: null,
      gate: {
        id: 'g-2',
        state: 'pending',
        round: 1,
        expiresAt: '2026-10-03T00:00:00.000Z',
        expired: false,
        payloadDigest: DIGEST,
      },
    },
  ],
  decisions: [],
  reservations: [],
};

const BY_NATHAN = { actorId: NATHAN.personId, personId: NATHAN.personId };
export const DETAIL: InternalTaskDetail = {
  ...(TASKS[0] as TaskSummary),
  description:
    'Pull the signed scope, the two variations and the renewal terms into one pack for review.',
  history: [
    { at: '2026-09-24T01:10:00.000Z', ...BY_NATHAN, operation: 'task.create' },
    { at: '2026-09-25T03:40:00.000Z', ...BY_NATHAN, operation: 'task.update' },
  ],
  comments: [
    {
      id: 'c-1',
      audience: 'internal',
      author: NATHAN.personId,
      body: 'Variation two is still unsigned; chase before the pack goes out.',
      comment_type: 'note',
      posted_at: '2026-09-25T04:00:00.000Z',
      edited_at: null,
      source: 'app',
    },
  ],
  proposals: [PROPOSAL],
  capCurrency: 'AUD',
  envelope: null,
  alerts: [],
};

// An earlier version of the same lineage was approved and ran: one run whose
// attempt has a receipt, so the Agent perspective draws the mockup's receipt
// box (states.json `receipt`).
export const EXECUTION: TaskExecutionResult = {
  execution: {
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
