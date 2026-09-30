// SPDX-License-Identifier: AGPL-3.0-only
//
// Made-up answers for the width-and-theme harness (UI-POLISH).
//
// The harness serves the app with its API at a dead port, so every data
// screen used to be photographed on its "could not be read" state: no
// sideways scroll proven on an error, nothing about the look. These answers
// let each screen draw rows. They are typed against the wire contract's own
// read shapes, so a changed read fails the typecheck here rather than drawing
// a screen from a shape the API no longer sends. Test side only: the page
// asks the same addresses it asks the real API; nothing here is a back end.
//
// The rows follow the pinned mockup's Projects board, so a capture reads
// against the mockup's page. Every name and client is made up.

import type {
  BoardTask,
  CapabilitiesResult,
  InboxCountResult,
  InboxReadResult,
  InternalTaskDetail,
  InternalTaskRead,
  PersonListResult,
  QueueResult,
  SettingsReadResult,
  TagListResult,
  TagView,
  TaskBoardResult,
  TaskExecutionResult,
  TaskStateView,
  TaskSummary,
  TaskTodosResult,
  TodoView,
} from '../../packages/core-wire/src/index.ts';
import type { BrowserContext } from 'playwright';
import type { ReadName } from '../../apps/web/src/operations/read-names.ts';

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

const NATHAN = { personId: 'p-nathan', name: 'Nathan' };
const MIA = { personId: 'p-mia', name: 'Mia' };

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

const DETAIL: InternalTaskDetail = {
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

const TAGS: readonly TagView[] = [
  { id: 'g-renewal', name: 'renewal' },
  { id: 'g-ads', name: 'ads' },
];

// My to-dos (MP-7-1): the reader's own open tasks, with tags and owed messages.
const todo = (at: number, tags: readonly TagView[], waitingComments = 0): TodoView => ({
  ...(TASKS[at] as BoardTask),
  tags,
  waitingComments,
});
const TODOS: readonly TodoView[] = [
  todo(0, TAGS.slice(0, 1)),
  todo(1, [], 2),
  todo(2, TAGS.slice(1)),
  todo(3, []),
  todo(5, []),
];

const READS = {
  'task.board': {
    ok: true,
    tasks: TASKS,
    changedAt: '2026-09-25T04:00:00.000Z',
    viewer: NATHAN.personId,
  } satisfies TaskBoardResult,
  'task.read': {
    ok: true,
    task: DETAIL,
    states: Object.values(STATE),
  } satisfies InternalTaskRead,
  'task.todos': { ok: true, todos: TODOS } satisfies TaskTodosResult,
  'tag.list': { ok: true, tags: TAGS } satisfies TagListResult,
  'person.list': { ok: true, persons: [NATHAN, MIA] } satisfies PersonListResult,
  'settings.read': {
    ok: true,
    settings: [
      {
        key: 'four_eyes_threshold',
        value: 500,
        valueType: 'numeric',
        updatedAt: '2026-09-20T00:00:00.000Z',
        updatedByActorId: NATHAN.personId,
        revision: 2,
      },
      {
        key: 'client_sign_off_required',
        value: true,
        valueType: 'boolean',
        updatedAt: '2026-09-20T00:00:00.000Z',
        updatedByActorId: NATHAN.personId,
        revision: 1,
      },
    ],
  } satisfies SettingsReadResult,
  'session.capabilities': {
    ok: true,
    personId: NATHAN.personId,
    businessKey: 'alpha',
    grants: [
      { collection: 'tasks', action: 'read' },
      { collection: 'tasks', action: 'write' },
      { collection: 'settings', action: 'manage' },
    ],
  } satisfies CapabilitiesResult,
  'task.queue': { ok: true, queue: [], alerts: [], outages: [] } satisfies QueueResult,
  'task.execution': {
    execution: { outcome: 'no-run', runs: [], events: [], complete: true, next: null },
  } satisfies TaskExecutionResult,
  'inbox.read': {
    ok: true,
    inbox: [
      {
        id: 'i-1',
        reason: 'decision',
        workState: 'open',
        access: 'readable',
        owed: true,
        counted: true,
        raisedAt: '2026-09-25T22:00:00.000Z',
        closedAt: null,
        seenAt: null,
        lastDelivery: 'delivered',
        task: { key: 'T-9', title: 'Sign off the Meridian ad run rate, 29% over budget' },
      },
      {
        id: 'i-2',
        reason: 'assignment',
        workState: 'open',
        access: 'readable',
        owed: true,
        counted: true,
        raisedAt: '2026-09-25T20:30:00.000Z',
        closedAt: null,
        seenAt: '2026-09-25T21:00:00.000Z',
        lastDelivery: 'delivered',
        task: { key: 'T-13', title: 'Approve the four review replies before they go out' },
      },
    ],
  } satisfies InboxReadResult,
  'inbox.count': { ok: true, owed: 2 } satisfies InboxCountResult,
} as const satisfies Partial<Record<ReadName, unknown>>;

/** The reads the harness answers; a read missing here draws its "could not be read" state. */
export const MADE_UP_READS: readonly string[] = Object.keys(READS);

/**
 * The made-up answer for one request path, or nothing for a path it does not
 * know. `/api/b/<business>/<collection>/<verb>` is a read's path (`pathOf`);
 * the tab's live stream is answered as down, so nothing streams in a capture.
 */
export function madeUpAnswer(pathname: string): { status: number; json?: unknown } | undefined {
  const match = /^\/api\/b\/[^/]+\/(.+)$/u.exec(pathname);
  if (match === null) return undefined;
  const rest = match[1] ?? '';
  if (rest === 'live' || rest.startsWith('live/')) return { status: 503 };
  const name = rest.replace('/', '.');
  if (name in READS) return { status: 200, json: READS[name as keyof typeof READS] };
  return undefined;
}

/**
 * Answers a context's reads from the made-up set. Registered after the side's
 * own routes, so it runs first (Playwright runs the last match first); a path
 * it does not know falls through to them.
 */
export async function answerMadeUp(context: BrowserContext): Promise<void> {
  await context.route('**/api/b/**', async (route) => {
    const answer = madeUpAnswer(new URL(route.request().url()).pathname);
    await (answer === undefined ? route.fallback() : route.fulfill(answer));
  });
}
