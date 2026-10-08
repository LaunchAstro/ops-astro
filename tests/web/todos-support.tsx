// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared by the MP-7-1 suites: a server answering the reader's own to-dos,
// recording every write by its path, and the Projects dock panel mounted on a
// fixed business day.
//
// A harness, not a suite: nothing here runs on its own.

import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TodosScreen } from '../../apps/web/src/screens/todos/Todos.tsx';
import { tick } from './task-page-stub.tsx';
import { json, mount } from './perspective-support.tsx';

/** 12:00 on Thursday 1 October 2026 on the business clock. */
export const NOW = new Date('2026-10-01T02:00:00Z');

const todo = (
  key: string,
  title: string,
  due: string | null,
  priority: number | null,
  over: Readonly<Record<string, unknown>> = {},
) => ({
  id: `id-${key}`,
  key,
  title,
  state: null,
  assignee: { personId: 'p-ada', name: 'Ada' },
  due,
  priority,
  completedAt: null,
  revision: 3,
  tags: [],
  waitingComments: 0,
  category: null,
  whoseMove: 'Team',
  ...over,
});

export const TODOS = [
  todo('Proj-Alpha', 'Budget brief', '2026-09-28', 2, {
    tags: [{ id: 'g-legal', name: 'Legal' }],
    waitingComments: 2,
    category: 'seo',
    whoseMove: 'Review',
  }),
  todo('Proj-Bravo', 'Call the client', '2026-10-01', 1, {
    category: 'content',
    whoseMove: 'Agent',
  }),
  todo('Proj-Charlie', 'Audit links', '2026-10-02', null, {
    tags: [{ id: 'g-launch', name: 'Launch' }],
  }),
  todo('Proj-Delta', 'Draft report', '2026-10-05', 3),
  todo('Proj-Echo', 'Plan the quarter', '2026-10-20', 2),
  todo('Proj-Foxtrot', 'Tidy the notes', null, null),
];

export interface Sent {
  readonly to: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * The reader's to-dos, every request recorded; the paths in `refuse` are
 * refused. A list read after the first waits for `held`, when given, so a
 * test can look at the screen while its reread is in flight. A record's first
 * write moves it to revision 4, so a second write at the same record is stale.
 */
export function serving(
  rows: readonly unknown[] = TODOS,
  refuse: readonly string[] = [],
  held?: Promise<void>,
) {
  const sent: Sent[] = [];
  const joins: string[] = [];
  const moved = new Set<unknown>();
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (at.endsWith('/live?topic=board')) {
      joins.push(at);
      return new Response(new ReadableStream(), {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    const to = at.replace(/^.*?(\/[a-z]+\/[a-z_]+)$/u, '$1');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'];
    sent.push({ to, body });
    const reread = sent.filter((one) => one.to === '/task/todos').length > 1;
    if (to === '/task/todos' && reread && held !== undefined) await held;
    if (to === '/task/todos') return json({ ok: true, todos: rows });
    // The scope switch's teammates and clients (MP-7-2).
    if (to === '/person/list') return json({ ok: true, persons: [] });
    if (to === '/client/list') return json({ ok: true, clients: [] });
    if (refuse.includes(to)) {
      const refusal = { refused: true, code: 'SCOPE_NOT_GRANTED', names: ['task'], fixes: [] };
      return json(refusal, 403);
    }
    if (moved.has(body['recordId'])) {
      const stale = {
        refused: true,
        code: 'VERSION_STALE',
        names: ['expectedRevision'],
        fixes: [],
      };
      return json(stale, 409);
    }
    moved.add(body['recordId']);
    return json({ recordId: body['recordId'], revision: 4 });
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    sent,
    joins,
  };
}

/** The panel, with a host that records what it was asked to open. */
export async function todos(
  over: {
    readonly client?: OperationsClient;
    readonly now?: Date;
  } = {},
) {
  const opened: string[] = [];
  const client = over.client ?? serving().client;
  const screen = (changes: number) => (
    <TodosScreen
      client={client}
      grantKey="alpha:member"
      onOpen={(key) => {
        opened.push(`${key}:open`);
      }}
      changes={changes}
      now={() => over.now ?? NOW}
    />
  );
  const view = await mount(screen(0));
  await tick();
  /** The panel host's change count moved: a write in the task panel. */
  const changed = async (changes: number): Promise<void> => {
    await view.render(screen(changes));
    await tick();
  };
  return { view, opened, changed };
}

type View = Awaited<ReturnType<typeof todos>>['view'];

/** The keys of the rows drawn, in order. */
export const keysOf = (view: View): readonly (string | undefined)[] =>
  view.all('[data-todo-row]').map((row) => (row as HTMLElement).dataset['todoRow']);

/** A row's due words. */
export const dueOf = (view: View, key: string): string | null | undefined =>
  view.host.querySelector(`[data-todo-row="${key}"] [data-todo-due]`)?.textContent;
