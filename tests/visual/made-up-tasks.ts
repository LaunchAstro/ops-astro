// SPDX-License-Identifier: AGPL-3.0-only
//
// The made-up task rows behind the harness's answers (made-up-api.ts): the
// Projects board's tasks, one task's detail, and the reader's to-dos. Split
// out for the file-length cap; every name and client is made up.

import type {
  BoardTask,
  InternalTaskDetail,
  TagView,
  TaskStateView,
  TaskSummary,
  TodoView,
} from '../../packages/core-wire/src/index.ts';
import { MIA, NATHAN } from './made-up-access.ts';

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
      operation: 'task.create',
    },
    {
      at: '2026-09-25T03:40:00.000Z',
      actorId: NATHAN.personId,
      actorKind: 'person',
      actorName: NATHAN.name,
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
  proposals: [],
  capCurrency: 'AUD',
  envelope: null,
  alerts: [],
  adHoc: false,
  clientAccess: false,
  board: null,
  steps: [],
  time: null,
  tags: [],
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
