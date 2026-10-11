// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// U113 (MP-7-1, CS-7.24, PJ-05): the to-do list's column heads sort by task,
// due and priority, and pressed again reverse. The sort, key and direction, is
// the person's own `todos.sort` preference: a reload draws it, a choice made
// before the read answers stands, and a refused save is said.

import { act } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TodosScreen } from '../../apps/web/src/screens/todos/Todos.tsx';
import { admitsPreference } from '../../packages/core-records/src/preferences/store.ts';
import { mount, settle, type Mounted } from '../surfaces/mount.tsx';
import { TODOS, NOW, keysOf } from './todos-support.tsx';

type Body = Readonly<Record<string, unknown>>;

/** One person's server; with `delayed`, each preference read waits to be answered. */
function server(initial: Body = {}, delayed = false) {
  let persisted = initial;
  let refuse = false;
  const saves: Body[] = [];
  const reads: (() => void)[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    const path = new URL(String(url), 'http://test').pathname;
    const body = JSON.parse(String(init?.body ?? '{}')) as Body;
    if (path.endsWith('/preference/read')) {
      const snapshot = persisted;
      return delayed
        ? new Promise<Response>((resolve) => {
            reads.push(() => resolve(Response.json({ preferences: snapshot })));
          })
        : Promise.resolve(Response.json({ preferences: persisted }));
    }
    if (path.endsWith('/preference/save')) {
      saves.push(body);
      if (refuse) {
        const fixes = ['Your preferences are not kept here.'];
        return Promise.resolve(
          Response.json(
            { refused: true, code: 'SCOPE_NOT_GRANTED', names: ['preference'], fixes },
            { status: 403 },
          ),
        );
      }
      persisted = { ...persisted, [String(body['preference'])]: body['value'] };
      return Promise.resolve(Response.json({ recordId: null, revision: null }));
    }
    return Promise.resolve(
      Response.json(
        path.endsWith('/task/todos')
          ? { ok: true, todos: TODOS }
          : path.endsWith('/person/list')
            ? { ok: true, persons: [] }
            : { ok: true, clients: [] },
      ),
    );
  };
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    saves,
    reads,
    refusing: (next: boolean) => {
      refuse = next;
    },
  };
}

const page = (client: OperationsClient, grantKey = 'alpha:ada') => (
  <TodosScreen client={client} grantKey={grantKey} now={() => NOW} />
);
async function head(view: Mounted, key: string) {
  await view.click(`[data-todos-sort="${key}"]`);
  await settle();
}
/** The sorts saved, each to `todos.sort` and no other key. */
function saved(api: ReturnType<typeof server>): readonly unknown[] {
  expect(api.saves.every((one) => one['preference'] === 'todos.sort')).toBe(true);
  return api.saves.map((one) => one['value']);
}
const label = (view: Mounted, key: string) =>
  view.find(`[data-todos-sort="${key}"]`)?.getAttribute('aria-label');

const DUE_FIRST = [
  'Proj-Alpha',
  'Proj-Bravo',
  'Proj-Charlie',
  'Proj-Delta',
  'Proj-Echo',
  'Proj-Foxtrot',
];
const DUE_LAST = [
  'Proj-Echo',
  'Proj-Delta',
  'Proj-Charlie',
  'Proj-Bravo',
  'Proj-Alpha',
  'Proj-Foxtrot',
];

it('Core06-2 the Due head reverses, keeps no due last, and a reload draws key and direction', async () => {
  const api = server();
  const view = await mount(page(api.client));
  await settle();
  expect(keysOf(view)).toStrictEqual(DUE_FIRST);
  expect(label(view, 'due')).toBe('Sort by Due, now ascending');
  expect(api.saves).toStrictEqual([]);

  await head(view, 'due');
  expect(keysOf(view)).toStrictEqual(DUE_LAST);
  expect(saved(api)).toStrictEqual([{ key: 'due', direction: 'desc' }]);
  await view.unmount();

  const reopened = await mount(page(api.client));
  await settle();
  expect(keysOf(reopened)).toStrictEqual(DUE_LAST);
  expect(label(reopened, 'due')).toBe('Sort by Due, now descending');
  await head(reopened, 'due');
  expect(keysOf(reopened)).toStrictEqual(DUE_FIRST);
});

it('Core06-2 the Task and Priority heads sort both ways, and no priority stays last', async () => {
  const api = server();
  const view = await mount(page(api.client));
  await settle();
  await head(view, 'task');
  expect(keysOf(view)).toStrictEqual([
    'Proj-Charlie',
    'Proj-Alpha',
    'Proj-Bravo',
    'Proj-Delta',
    'Proj-Echo',
    'Proj-Foxtrot',
  ]);
  await head(view, 'task');
  expect(keysOf(view)).toStrictEqual([
    'Proj-Foxtrot',
    'Proj-Echo',
    'Proj-Delta',
    'Proj-Bravo',
    'Proj-Alpha',
    'Proj-Charlie',
  ]);
  // Another head starts ascending: P1 first.
  await head(view, 'priority');
  expect(keysOf(view)).toStrictEqual([
    'Proj-Bravo',
    'Proj-Alpha',
    'Proj-Echo',
    'Proj-Delta',
    'Proj-Charlie',
    'Proj-Foxtrot',
  ]);
  await head(view, 'priority');
  expect(keysOf(view)).toStrictEqual([
    'Proj-Delta',
    'Proj-Alpha',
    'Proj-Echo',
    'Proj-Bravo',
    'Proj-Charlie',
    'Proj-Foxtrot',
  ]);
  expect(saved(api).at(-1)).toStrictEqual({ key: 'priority', direction: 'desc' });
});

it('Core06-3 a sort chosen before the read answers stands over the older stored sort', async () => {
  const api = server({ 'todos.sort': { key: 'priority', direction: 'desc' } }, true);
  const view = await mount(page(api.client));
  await settle();
  await head(view, 'task');
  const chosen = keysOf(view);
  await act(() => {
    for (const answer of api.reads.splice(0)) answer();
  });
  await settle();
  expect(keysOf(view)).toStrictEqual(chosen);
  expect(saved(api)).toStrictEqual([{ key: 'task', direction: 'asc' }]);
});

it('Core06-3 a refused sort save is said, and an unreadable stored sort draws the default', async () => {
  const api = server({ 'todos.sort': { key: 'colour', direction: 'sideways' } });
  const view = await mount(page(api.client));
  await settle();
  expect(keysOf(view)).toStrictEqual(DUE_FIRST);
  api.refusing(true);
  await head(view, 'task');
  await settle();
  expect(view.find('[data-todos-sort-refusal]')?.textContent).toContain(
    'Your preferences are not kept here.',
  );
});

it('Core06-4 another person signed in starts on the default sort, not the first person’s', async () => {
  const ada = server({ 'todos.sort': { key: 'task', direction: 'desc' } }, true);
  const view = await mount(page(ada.client));
  await settle();
  const ben = server();
  await view.render(page(ben.client, 'alpha:ben'));
  await settle();
  await act(() => {
    for (const answer of ada.reads.splice(0)) answer();
  });
  await settle();
  expect(keysOf(view)).toStrictEqual(DUE_FIRST);
  expect(ada.saves).toStrictEqual([]);
  expect(ben.saves).toStrictEqual([]);
});

it('Core06-6 the store admits only the closed sort shape', () => {
  for (const key of ['due', 'task', 'priority']) {
    for (const direction of ['asc', 'desc']) {
      expect(admitsPreference('todos.sort', { key, direction })).toBe(true);
    }
  }
  for (const value of [
    null,
    [],
    'due',
    { key: 'name', direction: 'asc' },
    { key: 'due', direction: 'up' },
    { key: 'due' },
    { key: 'task', direction: 'asc', personId: 'another-person' },
  ]) {
    expect(admitsPreference('todos.sort', value)).toBe(false);
  }
});
