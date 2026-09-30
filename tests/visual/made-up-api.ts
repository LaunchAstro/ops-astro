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
  InternalTaskRead,
  PersonListResult,
  QueueResult,
  SettingsReadResult,
  TagListResult,
  TaskBoardResult,
  TaskExecutionResult,
  TaskStateView,
  TaskSummary,
  TaskTodosResult,
} from '../../packages/core-wire/src/index.ts';
import type { BrowserContext } from 'playwright';
import { detailOf, MIA, NATHAN, STATE, STATES, todoOf } from './made-up-task.ts';
import type { ReadName } from '../../apps/web/src/operations/read-names.ts';

const task = (
  n: number,
  title: string,
  state: TaskStateView,
  due: string | null,
  assignee: TaskSummary['assignee'] = NATHAN,
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
  rank: { number: null, score: null, calc: '' },
  stage: null,
  clientSet: false,
  actualMinutes: 0,
  estimateMinutes: null,
  pageLink: null,
  statePosition: null,
  waitReason: null,
  awaitingDecision: false,
  agent: null,
  myAgents: [],
});

// The harness clock is 2026-09-26; dates sit either side of it.
export const TASKS: readonly BoardTask[] = [
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

const DETAIL = detailOf(TASKS[0] as BoardTask);

const READS = {
  'task.board': {
    ok: true,
    tasks: TASKS,
    changedAt: '2026-09-25T04:00:00.000Z',
    viewer: NATHAN.personId,
  } satisfies TaskBoardResult,
  'task.read': { ok: true, task: DETAIL, states: STATES } satisfies InternalTaskRead,
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
  'tag.list': {
    ok: true,
    tags: [
      { id: 'tag-legal', name: 'Legal' },
      { id: 'tag-renewal', name: 'Renewal' },
    ],
  } satisfies TagListResult,
  'task.todos': {
    ok: true,
    todos: TASKS.filter((one) => one.assignee?.personId === NATHAN.personId).map((one) =>
      todoOf(one),
    ),
  } satisfies TaskTodosResult,
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
