// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C2 on the page. Each tab keeps the seat its stream is handed, re-reads who
// else is on the task when the stream says presence changed, and marks the
// field it is editing. The server here is the real presence book and the real
// route parsers behind a door that admits each token as its person; the door
// itself, and the database, are `tests/api/c2-presence-live.test.ts`'s.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
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
const DUE = 'input[type="date"]';

const PEOPLE: Record<string, Omit<PresenceSession, 'sessionId'>> = {
  ana: { personId: 'p-ana', name: 'Ana Ng', side: 'staff' },
  ben: { personId: 'p-ben', name: 'Ben Ode', side: 'staff' },
  cleo: { personId: 'p-cleo', name: 'Cleo Client', side: 'client' },
};

const json = (body: unknown, status = 200): Response =>
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

/** The real book and route parsers; a tab's token is its person. */
function server() {
  const book = createLivePresence();
  const marks: string[] = [];
  const seats = new Map<string, string[]>();
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
  const fetchAs = (token: string) =>
    ((url: string | URL, init?: RequestInit) =>
      Promise.resolve(
        route(token, new URL(String(url), 'http://api.test'), String(init?.body)),
      )) as unknown as typeof globalThis.fetch;
  return { book, marks, seats, fetchAs };
}

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

async function until(say: string, check: () => boolean, deadline = Date.now() + 2000) {
  if (check()) return;
  if (Date.now() > deadline) throw new Error(`never happened: ${say}`);
  await act(async () => {
    await pause();
  });
  await until(say, check, deadline);
}

/** A tab: its own client (so its own stream and seat), the strip and the task page. */
async function tab(api: ReturnType<typeof server>, token: string, taskKey = 'TSK-2') {
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

const opened: Mounted[] = [];
const clients = new Map<string, OperationsClient>();
afterEach(async () => {
  // One at a time: React's act calls must not overlap.
  // eslint-disable-next-line no-await-in-loop
  for (const shown of opened.splice(0)) await shown.unmount();
});

const onTask = (page: Mounted): string => page.find('[data-presence="task"]')?.textContent ?? '';
const onStrip = (page: Mounted): string[] =>
  page.all('[data-presence="page"] [title]').map((avatar) => avatar.getAttribute('title') ?? '');

async function focus(page: Mounted, selector: string, on: boolean): Promise<void> {
  await until('the page is drawn', () => page.host.querySelector(selector) !== null);
  const input = page.host.querySelector(selector) as HTMLInputElement;
  await act(async () => {
    if (on) input.focus();
    else input.blur();
    await pause();
  });
}

it('C2 presence shown (task) on the page: each teammate sees the other, and who is editing the due date', async () => {
  const api = server();
  const ana = await tab(api, 'ana');
  const ben = await tab(api, 'ben');
  await until('each sees the other', () => onTask(ben).includes('Ana Ng is viewing'));
  await until('and the other way', () => onTask(ana).includes('Ben Ode is viewing'));

  await focus(ana, DUE, true);
  await until('Ben sees Ana editing the due date', () =>
    onTask(ben).includes('Ana Ng is editing Due date'),
  );
  expect(onTask(ana)).toBe('Ben Ode is viewing');

  await focus(ana, DUE, false);
  await until('back to viewing', () => onTask(ben).includes('Ana Ng is viewing'));

  await ana.unmount();
  opened.splice(opened.indexOf(ana), 1);
  await until('Ana has gone at once', () => !onTask(ben).includes('Ana Ng'));
  await ben.unmount();
  opened.splice(0);
  await until('everyone has gone, nothing held', () => api.book.held === 0);
});

it('C2 presence shown (page): the app strip shows who else is on this page from the same book, never the team list', async () => {
  const api = server();
  const ana = await tab(api, 'ana');
  const ben = await tab(api, 'ben');
  const elsewhere = await tab(api, 'cleo', 'TSK-3');
  await until('the strip names Ana on Ben’s page', () => onStrip(ben).includes('Ana Ng'));
  // Exactly who is here: the team list's Dee, on no page, is not drawn.
  expect(onStrip(ben)).toEqual(['Ana Ng']);
  expect(onStrip(ana)).toEqual(['Ben Ode']);
  expect(onStrip(elsewhere)).toEqual([]);

  await ana.unmount();
  opened.splice(opened.indexOf(ana), 1);
  await until('the strip empties when Ana leaves', () => onStrip(ben).length === 0);

  // Back on Ana's side: her tab's page closes and the strip keeps nobody from it.
  const back = await tab(api, 'ana');
  await until('Ana sees Ben again', () => onStrip(back).includes('Ben Ode'));
  await back.render(
    <PagePresenceProvider>
      <StripPresence />
    </PagePresenceProvider>,
  );
  expect(onStrip(back)).toEqual([]);
});

it('C2 a client session neither sees staff presence nor is seen (page)', async () => {
  const api = server();
  const ana = await tab(api, 'ana');
  const cleo = await tab(api, 'cleo');
  await focus(cleo, DUE, true);
  await until('the client tab has marked', () =>
    api.marks.some((mark) => mark.startsWith('cleo ')),
  );
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  });

  expect(onTask(ana)).toBe('');
  expect(onStrip(ana)).toEqual([]);
  expect(onTask(cleo)).toBe('');
  expect(onStrip(cleo)).toEqual([]);
  expect(cleo.text()).not.toContain('Ana Ng');
  expect(ana.text()).not.toContain('Cleo Client');
});

it('C2 a stream joined again carries the field still being edited to its new seat', async () => {
  const api = server();
  const ana = await tab(api, 'ana');
  const ben = await tab(api, 'ben');
  await focus(ana, DUE, true);
  await until('Ben sees the edit', () => onTask(ben).includes('Ana Ng is editing Due date'));

  // A second page in Ana's tab follows another task, so her stream joins
  // again naming both, and is handed a new seat.
  const client = clients.get('ana');
  if (client === undefined) throw new Error('no client');
  opened.push(await mount(<TaskDetailScreen client={client} grantKey="ana:g" taskKey="TSK-3" />));
  await until('a new seat', () => (api.seats.get('ana') ?? []).length === 2);
  const renewed = api.seats.get('ana')?.[1] ?? '';
  await until('the edit is marked on the new seat', () =>
    api.marks.some((mark) => mark.includes(renewed) && mark.includes('"field":"due"')),
  );
  await until('Ben still sees the edit', () => onTask(ben).includes('Ana Ng is editing Due date'));
});
