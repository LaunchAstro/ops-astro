// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-2's scoping seams on the Projects dock panel (CS-7.4): the list scoped
// to a teammate (picked from `person.list`, real), to a client, to a client's
// waiting comments, or to a client's route family. The clients are the
// business's own from `client.list` (C32), real and never mock-marked; a
// client's route family is the task page's actual whoseMove rule. The read each sends is the real `task.todos` scope. Each scope replaces the one
// before, and a door opens the panel already scoped. What a scope may read
// is the server's (`tests/commands/task-todos-scope*.test.ts`).

import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TodosScreen } from '../../apps/web/src/screens/todos/Todos.tsx';
import { ROUTE_FAMILIES, type TodoScope } from '../../apps/web/src/screens/todos/todo-scope.ts';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
import { NOW, TODOS, keysOf } from './todos-support.tsx';

afterEach(unmountAll);

const PEOPLE = [
  { personId: 'p-ada', name: 'Ada' },
  { personId: 'p-noah', name: 'Noah' },
];
/** The business's clients, as `client.list` answers them. */
const CLIENTS = [
  { clientId: 'c-acme', name: 'Acme Physio' },
  { clientId: 'c-north', name: 'Northside Dental' },
];
const ACME = { id: 'c-acme', name: 'Acme Physio' };
const CANARY = 'canary-noahs-secret';

/** Two tasks with messages waiting (2 and 1), the rest with none. */
const ROWS = TODOS.map((row) =>
  row.key === 'Proj-Charlie' ? { ...row, waitingComments: 1 } : row,
);

/** Every `task.todos` body sent, in order; a scope in `refuse` is refused NOT_FOUND. */
function serving(refuse: (body: Record<string, unknown>) => boolean = () => false) {
  const reads: Record<string, unknown>[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    if (String(url).endsWith('/person/list')) {
      return Promise.resolve(json({ ok: true, persons: PEOPLE }));
    }
    if (String(url).endsWith('/client/list')) {
      return Promise.resolve(json({ ok: true, clients: CLIENTS }));
    }
    if (String(url).endsWith('/task/todos')) {
      reads.push(body);
      if (refuse(body)) {
        const refusal = { refused: true, code: 'NOT_FOUND', names: ['person'], fixes: [] };
        return Promise.resolve(json(refusal, 404));
      }
      const rows = 'person' in body ? [{ ...TODOS[0], title: CANARY }] : ROWS;
      return Promise.resolve(json({ ok: true, todos: rows }));
    }
    return Promise.resolve(json({ recordId: body['recordId'], revision: 4 }));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { client, reads };
}

async function panel(
  over: {
    readonly scope?: TodoScope;
    readonly refuse?: (body: Record<string, unknown>) => boolean;
  } = {},
) {
  const { client, reads } = serving(over.refuse);
  const opened: string[] = [];
  const view = await mount(
    <TodosScreen
      client={client}
      grantKey="alpha:member"
      onOpen={(key) => {
        opened.push(key);
      }}
      now={() => NOW}
      {...(over.scope === undefined ? {} : { scope: over.scope })}
    />,
  );
  await tick();
  const choose = async (selector: string, value: string) => {
    await view.choose(selector, value);
    await tick();
  };
  return { view, reads, opened, choose, last: () => reads.at(-1) };
}

const options = (view: Awaited<ReturnType<typeof panel>>['view'], selector: string) =>
  view.all(`${selector} option`).map((option) => (option as HTMLOptionElement).value);

describe('MP-7-2 Scope to a client, a client’s waiting comments, a person, or a client’s route family', () => {
  it('a person: the teammate picker is person.list (real, never mock-marked); the read is theirs', async () => {
    const { view, choose, last } = await panel();
    expect(last()).toStrictEqual({});
    expect(options(view, '#todos-person')).toStrictEqual(['', 'p-ada', 'p-noah']);
    expect(view.find('#todos-person')?.closest('.is-mock')).toBeNull();
    await choose('#todos-person', 'p-noah');
    expect(last()).toStrictEqual({ person: 'p-noah' });
    expect(view.find('[data-todos-scope]')?.textContent).toContain('Noah');
    expect(view.text()).toContain(CANARY);
  });

  it('a client: the choices are client.list’s, real and never mock-marked; the read is the client’s', async () => {
    const { view, choose, last } = await panel();
    expect(view.find('#todos-client')?.closest('.is-mock')).toBeNull();
    expect(options(view, '#todos-client')).toStrictEqual(['', 'c-acme', 'c-north']);
    expect(view.text()).toContain('Northside Dental');
    await choose('#todos-client', ACME.id);
    expect(last()).toStrictEqual({ client: ACME.id });
    expect(view.find('[data-todos-scope]')?.textContent).toContain(ACME.name);
  });

  it('a client’s waiting comments: only tasks with messages owed, and the count is what lands', async () => {
    const { view, choose, last } = await panel();
    await choose('#todos-client', ACME.id);
    expect(view.find('[data-todos-waiting-count]')?.textContent).toContain('3');
    await view.click('#todos-waiting');
    await tick();
    expect(last()).toStrictEqual({ client: ACME.id });
    expect(keysOf(view)).toStrictEqual(['Proj-Alpha', 'Proj-Charlie']);
    const landed = view
      .all('[data-todo-comments]')
      .reduce((sum, chip) => sum + Number(chip.textContent?.split(' ')[0]), 0);
    // Opening the scope never changes the count, and the count equals what lands.
    expect(view.find('[data-todos-waiting-count]')?.textContent).toContain(String(landed));
  });

  it('a client’s route family: actual whoseMove filters the client read and is said in words', async () => {
    const { view, choose, last } = await panel();
    expect(view.find('#todos-family')?.closest('.is-mock')).toBeNull();
    await choose('#todos-client', ACME.id);
    expect(options(view, '#todos-family')).toStrictEqual(['', ...ROUTE_FAMILIES]);
    const family = ROUTE_FAMILIES[0] ?? '';
    await choose('#todos-family', family);
    expect(last()).toStrictEqual({ client: ACME.id });
    expect(view.find('[data-todos-scope]')?.textContent).toContain(family);
    expect(keysOf(view)).toStrictEqual(['Proj-Bravo']);
    expect(view.find('[data-todos-waiting-count]')).toBeNull();
  });
});

describe('MP-7-2 Each opens through the gesture law and replaces the previous scope', () => {
  it('a door opens the panel already scoped (the seam the Team and Clients panels call)', async () => {
    const { view, reads } = await panel({
      scope: { kind: 'person', personId: 'p-noah', name: 'Noah' },
    });
    expect(reads).toStrictEqual([{ person: 'p-noah' }]);
    expect(view.host.querySelector<HTMLSelectElement>('#todos-person')?.value).toBe('p-noah');
  });

  it('a client after a teammate replaces it: one scope sent, the picker back on mine', async () => {
    const { view, choose, last } = await panel();
    await choose('#todos-person', 'p-noah');
    await choose('#todos-client', ACME.id);
    expect(last()).toStrictEqual({ client: ACME.id });
    expect(view.host.querySelector<HTMLSelectElement>('#todos-person')?.value).toBe('');
    await choose('#todos-person', 'p-ada');
    expect(last()).toStrictEqual({ person: 'p-ada' });
    expect(view.host.querySelector<HTMLSelectElement>('#todos-client')?.value).toBe('');
  });

  it('back to mine reads the reader’s own list', async () => {
    const { view, choose, last } = await panel();
    await choose('#todos-person', 'p-noah');
    await view.click('[data-todos="mine"]');
    await tick();
    expect(last()).toStrictEqual({});
    expect(view.find('[data-todos-scope]')).toBeNull();
  });
});

describe('MP-7-2 A client’s or a person’s row opens the task itself', () => {
  it('a teammate’s row opens that task in the task panel, never a copy', async () => {
    const { view, choose, opened } = await panel();
    await choose('#todos-person', 'p-noah');
    await view.click('[data-todo-row="Proj-Alpha"] [data-todo-open]');
    expect(opened).toStrictEqual(['Proj-Alpha']);
  });
});

describe('MP-7-2 isolation (the panel)', () => {
  it('a refused scope shows the refusal and none of the rows the scope before it drew', async () => {
    const { view, choose } = await panel({ refuse: (body) => 'person' in body });
    await choose('#todos-person', 'p-noah');
    expect(keysOf(view)).toStrictEqual([]);
    expect(view.text()).not.toContain(CANARY);
    expect(view.text()).not.toContain('Budget brief');
    // The switch stays, so the reader can go back.
    expect(view.find('[data-todos="mine"]')).not.toBeNull();
  });
});
