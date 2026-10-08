// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { hubOf } from '../../apps/web/src/data/live.ts';
import { expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { TaskPanel } from '../../apps/web/src/screens/task/Panel.tsx';
import { TodosScreen } from '../../apps/web/src/screens/todos/Todos.tsx';
import { mount } from '../surfaces/mount.tsx';
import { tick } from './task-page-stub.tsx';
import { dependentServer, KEY } from './dependent-reads-support.ts';

const ignore = () => {};
const now = () => new Date('2026-10-01T02:00:00Z');
type Server = ReturnType<typeof dependentServer>;
type Kind = 'page' | 'panel' | 'todos';
function screen(server: Server, kind: Kind) {
  const props = { client: server.client, grantKey: 'alpha:ada' };
  if (kind === 'page') return <TaskDetailScreen {...props} taskKey={KEY} />;
  if (kind === 'panel')
    return (
      <TaskPanel
        {...props}
        opening={{ taskKey: KEY, door: 'reply', tab: 'internal' }}
        onChanged={ignore}
        onClose={ignore}
      />
    );
  return (
    <TodosScreen
      {...props}
      scope={{ kind: 'client', clientId: 'c-alpha', name: 'Alpha' }}
      now={now}
    />
  );
}
async function frame(server: Server) {
  await act(() => {
    server.frame();
  });
  await tick();
}
it.each(['page', 'panel', 'todos'] as const)(
  'recovers %s after a dependency read outage on the next permitted B frame',
  async (kind) => {
    const server = dependentServer();
    const stop = hubOf(server.client).follow('board', ignore);
    const view = await mount(screen(server, kind));
    await tick();
    const path = kind === 'todos' ? '/task/todos' : '/task/read';
    const before = server.requests(path).length;
    expect(server.streams()[0]).toContain('board');
    server.fail('outage');
    await frame(server);
    expect(view.text()).toContain('unavailable');
    expect(view.find(kind === 'todos' ? '[data-todo-row]' : '[data-task]')).toBeNull();
    expect(server.streams()[0]).toContain('board');
    server.fail(null);
    server.change();
    await frame(server);
    expect(server.requests(path)).toHaveLength(before + 2);
    if (kind === 'todos') {
      expect(view.all('[data-todo-row]')).toHaveLength(2);
      expect(view.find('[data-todos-waiting-count]')?.textContent).toContain('6 messages');
      expect(server.requests(path).at(-1)?.body).toStrictEqual({ client: 'c-alpha' });
    } else expect(view.find('[data-fact="rank"] output')?.textContent).toBe('#1');
    await view.unmount();
    stop();
  },
);
it('recovers cold compact Todos on online without a pre-admission privileged stream', async () => {
  const server = dependentServer();
  server.fail('outage');
  const view = await mount(screen(server, 'todos'));
  await tick();
  expect(view.text()).toContain('unavailable');
  expect(server.streams()).toHaveLength(0);
  const before = server.requests('/task/todos').length;
  server.fail(null);
  server.change();
  await act(() => {
    window.dispatchEvent(new Event('online'));
  });
  await tick();
  expect(server.requests('/task/todos')).toHaveLength(before + 1);
  expect(server.requests('/task/todos').at(-1)?.body).toStrictEqual({ client: 'c-alpha' });
  expect(view.all('[data-todo-row]')).toHaveLength(2);
  expect(server.streams()).toHaveLength(1);
  expect(server.streams()[0]).toContain('board');
  await view.unmount();
});

it('recovers cold default compact Todos on online with its exact initial scope body', async () => {
  const server = dependentServer();
  server.fail('outage');
  const view = await mount(<TodosScreen client={server.client} grantKey="alpha:ada" now={now} />);
  await tick();
  expect(view.text()).toContain('unavailable');
  expect(server.streams()).toHaveLength(0);
  const before = server.requests('/task/todos').length;
  const body = server.requests('/task/todos').at(-1)?.body;
  server.fail(null);
  server.change();
  await act(() => {
    window.dispatchEvent(new Event('online'));
  });
  await tick();
  expect(server.requests('/task/todos')).toHaveLength(before + 1);
  expect(server.requests('/task/todos').at(-1)?.body).toStrictEqual(body);
  expect(view.find('[data-todo-row]')).not.toBeNull();
  expect(server.streams()[0]).toContain('board');
  await view.unmount();
});
