// SPDX-License-Identifier: AGPL-3.0-only
//
// The made-up task the harness draws the task page and the dock task panel
// from (made-up-api.ts answers `task.read` with it): its states, its people,
// and one task that reads on a board, at a stage, with an estimate, logged
// time and a step waiting at a gate. Every name is made up.

import type {
  BoardTask,
  InternalTaskDetail,
  PersonView,
  StepView,
  TaskStateView,
  TodoView,
} from '../../packages/core-wire/src/index.ts';

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

export const NATHAN: PersonView = { personId: 'p-nathan', name: 'Nathan' };
export const MIA: PersonView = { personId: 'p-mia', name: 'Mia' };

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

const person = (who: PersonView) => ({ actorKind: 'person', actorName: who.name });

const HISTORY: InternalTaskDetail['history'] = [
  {
    at: '2026-09-24T01:10:00.000Z',
    actorId: NATHAN.personId,
    ...person(NATHAN),
    operation: 'task.create',
  },
  {
    at: '2026-09-25T03:40:00.000Z',
    actorId: NATHAN.personId,
    ...person(NATHAN),
    operation: 'task.update',
  },
];

const COMMENTS: InternalTaskDetail['comments'] = [
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
];

// T-1 as its page and the dock task panel read it: on a board, at a stage,
// with an estimate the time log burns against, and a step waiting at a gate.
export function detailOf(summary: BoardTask): InternalTaskDetail {
  return {
    ...summary,
    description:
      'Pull the signed scope, the two variations and the renewal terms into one pack for review.',
    agentBrief: null,
    pageLink: null,
    estimateMinutes: 90,
    history: HISTORY,
    comments: COMMENTS,
    proposals: [],
    capCurrency: 'AUD',
    envelope: null,
    alerts: [],
    rank: { number: 3, score: 42, calc: 'Due this week, standard priority' },
    adHoc: false,
    clientAccess: false,
    board: { readable: true, id: 'b-web', title: 'Website Projects' },
    stage: 'trust',
    clientSet: true,
    steps: STEPS,
    time: TIME,
    tags: [],
    agent: null,
    myAgents: [],
  };
}

/** The business's task states in the workflow's order, as `task.read` sends them. */
export const STATES: readonly TaskStateView[] = [
  STATE.hold,
  STATE.waiting,
  STATE.active,
  { id: 's-done', key: 'done', label: 'Complete', machineCategory: 'completed' },
];

/** A board row as the reader's own to-do (`task.todos`). */
export function todoOf(row: BoardTask): TodoView {
  return Object.assign({}, row, { tags: [], waitingComments: 0 });
}
