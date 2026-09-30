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
  ...over,
});

export const TODOS = [
  todo('Proj-Alpha', 'Budget brief', '2026-09-28', 2, {
    tags: [{ id: 'g-legal', name: 'Legal' }],
    waitingComments: 2,
  }),
  todo('Proj-Bravo', 'Call the client', '2026-10-01', 1),
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

/** The reader's to-dos, every request recorded; the paths in `refuse` are refused. */
export function serving(rows: readonly unknown[] = TODOS, refuse: readonly string[] = []) {
  const sent: Sent[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const to = String(url).replace(/^.*?(\/[a-z]+\/[a-z_]+)$/u, '$1');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'];
    sent.push({ to, body });
    if (to === '/task/todos') return Promise.resolve(json({ ok: true, todos: rows }));
    if (refuse.includes(to)) {
      const refusal = { refused: true, code: 'SCOPE_NOT_GRANTED', names: ['task'], fixes: [] };
      return Promise.resolve(json(refusal, 403));
    }
    return Promise.resolve(json({ recordId: body['recordId'], revision: 4 }));
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    sent,
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
  const view = await mount(
    <TodosScreen
      client={over.client ?? serving().client}
      grantKey="alpha:member"
      onOpen={(key) => {
        opened.push(`${key}:open`);
      }}
      now={() => over.now ?? NOW}
    />,
  );
  await tick();
  return { view, opened };
}

type View = Awaited<ReturnType<typeof todos>>['view'];

/** The keys of the rows drawn, in order. */
export const keysOf = (view: View): readonly (string | undefined)[] =>
  view.all('[data-todo-row]').map((row) => (row as HTMLElement).dataset['todoRow']);

/** A row's due words. */
export const dueOf = (view: View, key: string): string | null | undefined =>
  view.host.querySelector(`[data-todo-row="${key}"] [data-todo-due]`)?.textContent;
