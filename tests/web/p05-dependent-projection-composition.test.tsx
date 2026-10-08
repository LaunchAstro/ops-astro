// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { TodosScreen } from '../../apps/web/src/screens/todos/Todos.tsx';
import { mount } from '../surfaces/mount.tsx';
import { tick } from './task-page-stub.tsx';
import { key } from './typed-todo-refresh-support.tsx';
import { dependentServer } from './dependent-reads-support.ts';

const now = () => new Date('2026-10-01T02:00:00Z');
type Server = ReturnType<typeof dependentServer>;
const screen = (server: Server, grantKey = 'alpha:ada') => (
  <TodosScreen
    client={server.client}
    grantKey={grantKey}
    scope={{ kind: 'client', clientId: 'c-alpha', name: 'Alpha' }}
    now={now}
  />
);
async function frame(server: Server) {
  await act(async () => {
    server.frame();
    await Promise.resolve();
  });
  await tick();
}

it('waits for the first compact task admission despite already permitted vocabulary', async () => {
  const server = dependentServer();
  server.hold();
  const view = await mount(screen(server));
  await tick();
  expect(server.requests('/person/list')).toHaveLength(1);
  expect(server.requests('/client/list')).toHaveLength(1);
  expect(server.streams()).toHaveLength(0);
  await act(() => {
    server.release();
  });
  await tick();
  expect(server.streams()).toHaveLength(1);
  expect(server.streams()[0]).toContain('board');
  expect(view.all('[data-todo-row]')).toHaveLength(1);
  await view.unmount();
});

it('withdraws compact BOARD on task denial while vocabulary remains permitted', async () => {
  const server = dependentServer();
  const view = await mount(screen(server));
  await tick();
  server.fail('denied');
  await frame(server);
  expect(view.text()).toContain('SCOPE_NOT_GRANTED');
  expect(view.all('[data-todo-row]')).toHaveLength(0);
  expect(server.streams()).toHaveLength(0);
  const before = server.sent.length;
  await frame(server);
  expect(server.sent).toHaveLength(before);
  await view.unmount();
});

it('retains admitted compact dependency through a held vocabulary refresh and task outage', async () => {
  const server = dependentServer();
  const view = await mount(screen(server));
  await tick();
  server.holdPeople();
  server.fail('outage');
  await frame(server);
  expect(view.all('[data-todo-row]')).toHaveLength(0);
  expect(server.streams()[0]).toContain('board');
  await act(() => {
    server.release();
  });
  await tick();
  expect(view.text()).toContain('unavailable');
  expect(server.streams()[0]).toContain('board');
  server.fail(null);
  server.change();
  await frame(server);
  expect(view.all('[data-todo-row]')).toHaveLength(2);
  expect(view.find('[data-todos-waiting-count]')?.textContent).toContain('6 messages');
  expect(server.requests('/task/todos').at(-1)?.body).toStrictEqual({ client: 'c-alpha' });
  await view.unmount();
});

it('coalesces a compact online floor and BOARD recovery to one read per projection', async () => {
  const server = dependentServer();
  const view = await mount(screen(server));
  await tick();
  const paths = ['/person/list', '/client/list', '/task/todos'];
  const before = paths.map((path) => server.requests(path).length);
  await act(async () => {
    window.dispatchEvent(new Event('online'));
    await Promise.resolve();
  });
  await tick();
  expect(paths.map((path) => server.requests(path).length)).toStrictEqual(
    before.map((count) => count + 1),
  );
  expect(server.streams()).toHaveLength(1);
  expect(server.requests('/task/todos').at(-1)?.body).toStrictEqual({ client: 'c-alpha' });
  await view.unmount();
});

it('cancels a queued compact refresh when its admitted owner departs', async () => {
  const server = dependentServer();
  const view = await mount(screen(server));
  await tick();
  const queued: VoidFunction[] = [];
  const queue = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((run) => {
    queued.push(run);
  });
  try {
    server.change();
    await frame(server);
    expect(queued.length).toBeGreaterThan(0);
    const next = dependentServer();
    next.fail('denied');
    await view.render(screen(next, 'alpha:next-owner'));
    await tick();
    const before = server.sent.length;
    await act(() => {
      for (const run of queued) run();
    });
    await tick();
    expect(server.sent).toHaveLength(before);
    expect(view.all('[data-todo-row]')).toHaveLength(0);
    expect(next.streams()).toHaveLength(0);
  } finally {
    queue.mockRestore();
    await view.unmount();
  }
});

it.each(['person', 'client'] as const)(
  'keeps the typed %s dependency admitted through vocabulary loading and outage',
  async (kind) => {
    const server = dependentServer();
    server.permitPerson();
    const view = await mount(<TodosScreen client={server.client} grantKey="alpha:ada" now={now} />);
    await view.type('#todos-search', `${kind}:"${kind === 'person' ? 'Ada' : 'Alpha'}"`);
    await key(view, '#todos-search', 'Enter');
    const body = kind === 'person' ? { person: 'p-ada' } : { client: 'c-alpha' };
    expect(server.requests('/task/todos').at(-1)?.body).toStrictEqual(body);
    server.holdPeople();
    server.fail('outage');
    await frame(server);
    expect(view.all('[data-todo-row]')).toHaveLength(0);
    expect(server.streams()[0]).toContain('board');
    server.peopleOutage(true);
    await act(() => {
      server.release();
    });
    await tick();
    expect(server.streams()[0]).toContain('board');
    expect(view.all('[data-todo-row]')).toHaveLength(0);
    server.peopleOutage(false);
    server.fail(null);
    server.change();
    await frame(server);
    expect(view.all('[data-todo-row]')).toHaveLength(2);
    expect(server.requests('/task/todos').at(-1)?.body).toStrictEqual(body);
    await view.unmount();
  },
);
