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
// The rows (made-up-tasks.ts) follow the pinned mockup's Projects board, so a capture reads
// against the mockup's page. Every name and client is made up.

import type {
  CapabilitiesResult,
  ClientListResult,
  InboxCountResult,
  InboxReadResult,
  InternalTaskRead,
  PersonListResult,
  QueueResult,
  SessionPersonResult,
  SettingsReadResult,
  TagListResult,
  TaskBoardResult,
  TaskExecutionResult,
  TaskSearchResult,
  TaskTodosResult,
  TeamListResult,
} from '../../packages/core-wire/src/index.ts';
import type { BrowserContext } from 'playwright';
import type { ReadName } from '../../apps/web/src/operations/read-names.ts';
import { ACCESS, HARBOUR, MERIDIAN, MIA, NATHAN, OPERATIONS } from './made-up-access.ts';
import { DETAIL, LEDGER, STATE, TAGS, TASKS, TODOS } from './made-up-rows.ts';

export { TASKS } from './made-up-rows.ts';

/** One business setting as `settings.read` answers it, last written by Nathan. */
const setting = (key: string, value: number | boolean, revision: number) => ({
  key,
  value,
  valueType: typeof value === 'boolean' ? ('boolean' as const) : ('numeric' as const),
  updatedAt: '2026-09-20T00:00:00.000Z',
  updatedByActorId: NATHAN.personId,
  revision,
});

const READS = {
  'task.board': {
    ok: true,
    tasks: TASKS,
    changedAt: '2026-09-25T04:00:00.000Z',
    viewer: NATHAN.personId,
    owed: 0,
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
      setting('four_eyes_threshold', 500, 2),
      setting('client_sign_off_required', true, 1),
      setting('conversation_window_days', 30, 1),
      setting('retention_window_days', 365, 1),
    ],
  } satisfies SettingsReadResult,
  // The person's own store (MP-2-11a): no appearance, so the capture's colour
  // scheme draws; two dismissals no page draws, so the reset has a count.
  'preference.read': {
    ok: true,
    preferences: { 'tips.dismissed': { 'agency:settings#one': 1, 'agency:settings#two': 1 } },
  },
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
        client: MERIDIAN,
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
        client: HARBOUR,
      },
      {
        id: 'i-3',
        reason: 'run_finished',
        workState: 'open',
        access: 'readable',
        owed: false,
        counted: false,
        raisedAt: '2026-09-25T18:10:00.000Z',
        closedAt: null,
        seenAt: null,
        lastDelivery: 'delivered',
        task: { key: 'T-17', title: 'Shopping feed clean-up' },
      },
    ],
  } satisfies InboxReadResult,
  'inbox.count': { ok: true, owed: 2 } satisfies InboxCountResult,
  'session.person': { ok: true, person: { name: NATHAN.name } } satisfies SessionPersonResult,
  'team.list': {
    ok: true,
    you: NATHAN.personId,
    people: [
      { personId: NATHAN.personId, name: NATHAN.name, availability: null },
      { personId: MIA.personId, name: MIA.name, availability: { state: 'away', reason: 'Leave' } },
    ],
  } satisfies TeamListResult,
  'task.ledger': LEDGER,
  'task.search': {
    ok: true,
    hits: TASKS.slice(0, 3).map(({ id, key, title }) => ({ id, key, title })),
  } satisfies TaskSearchResult,
  'access.read': ACCESS,
  'operations.read': OPERATIONS,
  // The business's clients (C32), as the task's client field and the to-dos'
  // client scope ask them.
  'client.list': { ok: true, clients: [HARBOUR, MERIDIAN] } satisfies ClientListResult,
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
