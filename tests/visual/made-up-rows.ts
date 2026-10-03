// SPDX-License-Identifier: AGPL-3.0-only
//
// The made-up rows the harness's reads answer with (made-up-api.ts): the
// board's tasks after the pinned mockup's Projects board, T-1 as its page and
// dock panel read it, the Work log, the tags and the reader's to-dos. Every
// name and client is made up.

import type {
  BoardTask,
  InternalTaskDetail,
  StepView,
  TagView,
  TaskLedgerResult,
  TaskStateView,
  TaskSummary,
  TodoView,
} from '../../packages/core-wire/src/index.ts';
import { MIA, NATHAN } from './made-up-access.ts';
import { AGENT_LEDGER, AGENT_PROPOSALS } from './made-up-agent.ts';

export const STATE: Readonly<Record<'active' | 'waiting' | 'hold', TaskStateView>> = {
  active: { id: 's-active', key: 'active', label: 'Active', machineCategory: 'started' },
  waiting: {
    id: 's-waiting',
    key: 'waiting',
    label: 'Waiting on client',
    machineCategory: 'backlog',
  },
  hold: { id: 's-hold', key: 'hold', label: 'On hold', machineCategory: 'unstarted' },
};

const task = (
  n: number,
  title: string,
  state: TaskStateView,
  due: string | null,
  assignee: TaskSummary['assignee'] = NATHAN,
  board: Partial<BoardTask> = {},
): BoardTask => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  key: `T-${String(n)}`,
  title,
  state,
  assignee,
  due,
  priority: null,
  completedAt: null,
  revision: 1,
  // What the Projects board's cells draw (MP-5-8), made up like the rest.
  rank: { number: n, score: 100 - n, calc: 'made up' },
  stage: null,
  clientSet: true,
  client: null,
  actualMinutes: 0,
  estimateMinutes: null,
  pageLink: null,
  statePosition: state.key === 'active' ? 1 : state.key === 'waiting' ? 2 : 3,
  waitReason: null,
  awaitingDecision: false,
  agent: null,
  myAgents: [],
  // The reader's own waiting client signals and mentions (MP-5-8), none here.
  comments: { client: 0, mentions: 0, latest: null },
  category: null,
  ...board,
});

// The harness clock is 2026-09-26; dates sit either side of it.
export const TASKS: readonly BoardTask[] = [
  task(1, 'Contract review pack, 31 July', STATE.active, '2026-09-30', NATHAN, {
    stage: 'Build',
    estimateMinutes: 240,
    actualMinutes: 95,
  }),
  task(6, 'Renewal pack, 14 August', STATE.active, '2026-10-07', NATHAN, { stage: 'Brief' }),
  task(
    9,
    'Sign off the Meridian ad run rate, 29% over budget',
    STATE.active,
    '2026-09-18',
    NATHAN,
    {
      waitReason: 'needs_approval',
      awaitingDecision: true,
    },
  ),
  task(13, 'Approve the four review replies before they go out', STATE.active, '2026-09-26'),
  task(15, 'Ads rebuild: cost per enquiry', STATE.active, '2026-10-06', MIA),
  task(17, 'Shopping feed clean-up', STATE.active, '2026-10-05'),
  task(24, 'New patient offer campaign', STATE.active, '2026-10-09'),
  task(4, 'Budget pacing fix', STATE.waiting, '2026-10-01', null),
  task(33, 'Paid social rebuild', STATE.hold, null),
];

const step = (n: number, title: string, gate = false): StepView => ({
  id: `00000000-0000-4000-8001-${String(n).padStart(12, '0')}`,
  key: `T-${String(100 + n)}`,
  title,
  state: STATE.active,
  done: false,
  archived: null,
  awaitingApproval: gate,
  assignee: gate ? null : NATHAN,
  revision: 1,
});

// T-1's page and dock panel draw an estimate the logged time burns against
// (DT-09) and a step waiting at its gate (DT-04), as the mockup's panel does.
const STEPS: readonly StepView[] = [
  step(1, 'Collect the signed scope and both variations'),
  step(2, 'Draft the renewal terms summary'),
  step(3, 'Approve the pack before it goes to the client', true),
];

const TIME: InternalTaskDetail['time'] = {
  entries: [
    {
      id: 'te-1',
      startedAt: '2026-09-25T01:00:00.000Z',
      endedAt: '2026-09-25T01:45:00.000Z',
      minutes: 45,
      note: 'Pulled the scope and variations',
      adHoc: false,
      source: 'log',
    },
  ],
  running: null,
  totalMinutes: 45,
};

export const DETAIL: InternalTaskDetail = {
  ...(TASKS[0] as BoardTask),
  agentBrief: null,
  description:
    'Pull the signed scope, the two variations and the renewal terms into one pack for review.',
  history: [
    {
      at: '2026-09-24T01:10:00.000Z',
      actorId: NATHAN.personId,
      actorKind: 'person',
      actorName: NATHAN.name,
      personId: NATHAN.personId,
      operation: 'task.create',
    },
    {
      at: '2026-09-25T03:40:00.000Z',
      actorId: NATHAN.personId,
      actorKind: 'person',
      actorName: NATHAN.name,
      personId: NATHAN.personId,
      operation: 'task.update',
    },
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
      parent: null,
      signal: null,
      own: true,
    },
  ],
  // Harbour Physio (made-up-access.ts), and the task has content: its client is locked.
  client: 'c-harbour',
  hasContent: true,
  // The run on T-1 (made-up-agent.ts): its newest version waits at an armed
  // gate, so the task page draws the mockup's gate box (states.json `gate`).
  // The gate's deadline sits after the harness clock, so it reads pending.
  proposals: AGENT_PROPOSALS,
  capCurrency: 'AUD',
  envelope: null,
  alerts: [],
  ledger: AGENT_LEDGER,
  adHoc: false,
  clientAccess: false,
  board: null,
  pageLink: '/agency/clients/harbour-physio/',
  estimateMinutes: 90,
  steps: STEPS,
  time: TIME,
  tags: [],
};

/** The Work log's two days, newest first, as `task.ledger` answers them (MP-8-4). */
export const LEDGER: TaskLedgerResult = {
  ok: true,
  earlier: true,
  days: [
    {
      day: '2026-09-26',
      events: [
        {
          id: 'e-3',
          at: '2026-09-26T01:20:00.000Z',
          actorName: NATHAN.name,
          operation: 'task.complete',
          task: { key: 'T-13', title: 'Approve the four review replies before they go out' },
        },
        {
          id: 'e-2',
          at: '2026-09-25T23:05:00.000Z',
          actorName: MIA.name,
          operation: 'task.comment',
          task: { key: 'T-15', title: 'Ads rebuild: cost per enquiry' },
        },
      ],
    },
    {
      day: '2026-09-25',
      events: [
        {
          id: 'e-1',
          at: '2026-09-25T03:40:00.000Z',
          actorName: NATHAN.name,
          operation: 'task.update',
          task: { key: 'T-1', title: 'Contract review pack, 31 July' },
        },
      ],
    },
  ],
};

export const TAGS: readonly TagView[] = [
  { id: 'g-renewal', name: 'renewal' },
  { id: 'g-ads', name: 'ads' },
];

// My to-dos (MP-7-1): the reader's own open tasks, with tags and owed messages.
const todo = (at: number, tags: readonly TagView[], waitingComments = 0): TodoView => ({
  ...(TASKS[at] as BoardTask),
  tags,
  waitingComments,
});
export const TODOS: readonly TodoView[] = [
  todo(0, TAGS.slice(0, 1)),
  todo(1, [], 2),
  todo(2, TAGS.slice(1)),
  todo(3, []),
  todo(5, []),
];
