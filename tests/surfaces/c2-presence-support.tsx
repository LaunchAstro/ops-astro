// SPDX-License-Identifier: AGPL-3.0-only
//
// C2 page suites' server and tabs. The server is the real presence book and
// the real route parsers behind a door that admits each token as its person;
// the door itself, and the database, are `tests/api/c2-presence-live.test.ts`'s.
// A case may hold a tab's next presence answer (computed, then delivered late)
// or its next mark (applied late), to test what arrives out of order.

import { act } from 'react';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { PagePresenceProvider, StripPresence } from '../../apps/web/src/views/presence.tsx';
import { createLivePresence, markOf, presenceAskOf } from '../../apps/api/live-presence.ts';
import type { PresenceSession } from '../../apps/api/presence.ts';
import { mount, type Mounted } from './mount.tsx';

const BUSINESS = 'b1';
const TASK = '22222222-2222-4222-8222-222222222222';
const OTHER_TASK = '33333333-3333-4333-8333-333333333333';
// Two tabs in one document share element ids, so each page's input is found by kind.
export const DUE = 'input[type="date"]';

const PEOPLE: Record<string, Omit<PresenceSession, 'sessionId'>> = {
  ana: { personId: 'p-ana', name: 'Ana Ng', side: 'staff' },
  ben: { personId: 'p-ben', name: 'Ben Ode', side: 'staff' },
  cleo: { personId: 'p-cleo', name: 'Cleo Client', side: 'client' },
};

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refused = (): Response =>
  json({ refused: true, code: 'NOT_FOUND', names: [], fixes: ['Check the seat.'] }, 404);

const task = (id: string) => ({
  id,
  key: 'TSK-2',
  title: 'Presence',
  description: null,
  state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 1,
  history: [],
  comments: [],
});

type Book = ReturnType<typeof createLivePresence>;
type Who = Omit<PresenceSession, 'sessionId'>;
const encoder = new TextEncoder();

/** `/live`: the seat first, then every named topic seated in the book until the stream ends. */
function stream(book: Book, who: Who, seat: string, topics: readonly string[]): Response {
  let leaves: (() => void)[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: string) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      send('seat', seat);
      leaves = topics.map((topic) =>
        book.seat(BUSINESS, topic.slice(5), { ...who, sessionId: seat }, () => {
          send('presence', topic);
        }),
      );
    },
    cancel() {
      for (const leave of leaves) leave();
    },
  });
  return new Response(body, { status: 200 });
}

function seenBy(book: Book, who: Who, at: URL): Response {
  const queries: Record<string, string[]> = {};
  for (const [name, value] of at.searchParams) (queries[name] ??= []).push(value);
  const asked = presenceAskOf(queries);
  if ('code' in asked) return json(asked, 400);
  const seen = book.seenBy(BUSINESS, asked.taskId, asked.seat, who.personId);
  return seen === undefined ? refused() : json({ seenBy: seen });
}

function markIn(book: Book, who: Who, body: string): Response {
  const asked = markOf(JSON.parse(body) as Record<string, unknown>);
  if ('code' in asked) return json(asked, 400);
  const done = book.mark(BUSINESS, asked.taskId, asked.seat, who.personId, asked.field);
  return done ? json({ marked: true }) : refused();
}

/** `token kind` to the promise its next request of that kind waits on. */
function gates() {
  const holds = new Map<string, Promise<void>>();
  const hold = (token: string, kind: 'presence' | 'mark'): (() => void) => {
    let release: (() => void) | undefined;
    holds.set(
      `${token} ${kind}`,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return () => release?.();
  };
  return { holds, hold };
}

/** The real book and route parsers; a tab's token is its person. */
export function server() {
  const book = createLivePresence();
  const marks: string[] = [];
  const seats = new Map<string, string[]>();
  const refusing = new Set<string>();
  const route = (token: string, at: URL, body: string): Response => {
    const who = PEOPLE[token];
    if (who === undefined) throw new Error(`no person ${token}`);
    const path = at.pathname;
    // The team list names someone who is on no page: never drawn as presence.
    if (path.endsWith('/person/list'))
      return json({ ok: true, persons: [{ personId: 'p-dee', name: 'Dee Away' }] });
    if (path.endsWith('/task/read')) {
      const { recordId } = JSON.parse(body) as { recordId: string };
      return json({ ok: true, task: task(recordId === 'TSK-3' ? OTHER_TASK : TASK) });
    }
    if (path.endsWith('/live')) {
      if (refusing.has(token)) return refused();
      const seat = crypto.randomUUID();
      seats.set(token, [...(seats.get(token) ?? []), seat]);
      return stream(book, who, seat, at.searchParams.getAll('topic'));
    }
    if (path.endsWith('/live/presence')) return seenBy(book, who, at);
    if (path.endsWith('/live/mark')) {
      marks.push(`${token} ${body}`);
      return markIn(book, who, body);
    }
    throw new Error(`unrouted ${path}`);
  };
  const { holds, hold } = gates();
  const fetchAs = (token: string) =>
    (async (url: string | URL, init?: RequestInit) => {
      const at = new URL(String(url), 'http://api.test');
      const answer = () => route(token, at, String(init?.body));
      const kind = at.pathname.endsWith('/live/mark') ? 'mark' : 'presence';
      const held = at.pathname.includes('/live/') ? holds.get(`${token} ${kind}`) : undefined;
      if (held === undefined) return answer();
      holds.delete(`${token} ${kind}`);
      // A presence answer is read now and arrives late; a mark arrives late.
      const early = kind === 'presence' ? answer() : undefined;
      await held;
      return early ?? answer();
    }) as unknown as typeof globalThis.fetch;
  return { book, marks, seats, fetchAs, hold, refusing };
}

export const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

export async function until(say: string, check: () => boolean, deadline = Date.now() + 2000) {
  if (check()) return;
  if (Date.now() > deadline) throw new Error(`never happened: ${say}`);
  await act(async () => {
    await pause();
  });
  await until(say, check, deadline);
}

/** A tab: its own client (so its own stream and seat), the strip and the task page. */
export async function tab(api: ReturnType<typeof server>, token: string, taskKey = 'TSK-2') {
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    token,
    fetch: api.fetchAs(token),
  });
  clients.set(token, client);
  const shown = await mount(
    <PagePresenceProvider>
      <StripPresence />
      <TaskDetailScreen client={client} grantKey={`${token}:g`} taskKey={taskKey} />
    </PagePresenceProvider>,
  );
  opened.push(shown);
  return shown;
}

export const opened: Mounted[] = [];
export const clients = new Map<string, OperationsClient>();

/** Every tab a case opened, closed one at a time. */
export async function closeAll(): Promise<void> {
  // One at a time: React's act calls must not overlap.
  // eslint-disable-next-line no-await-in-loop
  for (const shown of opened.splice(0)) await shown.unmount();
}

export const onTask = (page: Mounted): string =>
  page.find('[data-presence="task"]')?.textContent ?? '';
export const onStrip = (page: Mounted): string[] =>
  page.all('[data-presence="page"] [title]').map((avatar) => avatar.getAttribute('title') ?? '');

export async function focus(page: Mounted, selector: string, on: boolean): Promise<void> {
  await until('the page is drawn', () => page.host.querySelector(selector) !== null);
  const input = page.host.querySelector(selector) as HTMLInputElement;
  await act(async () => {
    if (on) input.focus();
    else input.blur();
    await pause();
  });
}
