// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { TaskPanel } from '../../apps/web/src/screens/task/Panel.tsx';
import { TodosScreen } from '../../apps/web/src/screens/todos/Todos.tsx';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { tick, TASK_ID } from './task-page-stub.tsx';
import { dependentServer, KEY } from './dependent-reads-support.ts';

const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
afterEach(() => {
  if (visibility === undefined) Reflect.deleteProperty(document, 'visibilityState');
  else Object.defineProperty(document, 'visibilityState', visibility);
});
const ignore = () => {};
const now = () => new Date('2026-10-01T02:00:00Z');
type Server = ReturnType<typeof dependentServer>;
async function emit(server: Server, name = 'invalidate', topic = 'board') {
  await act(() => {
    server.frame(name, topic);
  });
  await tick();
}
const page = (server: Server, grantKey = 'alpha:ada') => (
  <TaskDetailScreen client={server.client} grantKey={grantKey} taskKey={KEY} />
);
const panel = (server: Server) => (
  <TaskPanel
    client={server.client}
    grantKey="alpha:ada"
    opening={{ taskKey: KEY, door: 'reply', tab: 'internal' }}
    onChanged={ignore}
    onClose={ignore}
  />
);
const todos = (server: Server) => (
  <TodosScreen
    client={server.client}
    grantKey="alpha:ada"
    scope={{ kind: 'client', clientId: 'c-alpha', name: 'Alpha' }}
    now={now}
  />
);
function field(view: Mounted, selector: string): HTMLTextAreaElement | HTMLInputElement {
  const node = view.host.querySelector(selector);
  if (!(node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement))
    throw new Error(`Missing ${selector}`);
  return node;
}
function rankOf(view: Mounted) {
  return view.find('[data-fact="rank"] output')?.textContent;
}

it.each(['page', 'panel'] as const)(
  'refreshes %s rank from B while preserving the exact editor and caret',
  async (kind) => {
    const server = dependentServer();
    const view = await mount(kind === 'page' ? page(server) : panel(server));
    await tick();
    const selector = kind === 'page' ? '[data-step-add]' : '#panel-comment-body';
    await view.type(selector, 'Unsent words on A');
    const input = field(view, selector);
    input.focus();
    input.setSelectionRange(3, 8);
    expect(rankOf(view)).toBe('#4');
    const before = server.requests('/task/read').length;
    server.hold();
    server.change();
    await emit(server);
    expect(server.requests('/task/read')).toHaveLength(before + 1);
    expect(field(view, selector)).toBe(input);
    expect(input.value).toBe('Unsent words on A');
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toStrictEqual([3, 8]);
    await act(() => {
      server.release();
    });
    await tick();
    expect(rankOf(view)).toBe('#1');
    expect(field(view, selector)).toBe(input);
    expect(input.value).toBe('Unsent words on A');
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toStrictEqual([3, 8]);
    expect(view.find('[data-revision="4"]')).not.toBeNull();
    expect(server.requests('/task/read')).toHaveLength(before + 1);
    await view.unmount();
  },
);

it('refreshes scoped compact Todos rows and counts using the same authorised body', async () => {
  const server = dependentServer();
  const view = await mount(todos(server));
  await tick();
  expect(view.find('[data-todos-waiting-count]')?.textContent).toContain('2 messages');
  const first = server.requests('/task/todos').at(-1)?.body;
  expect(first).toStrictEqual({ client: 'c-alpha' });
  const before = server.requests('/task/todos').length;
  server.change();
  await emit(server);
  expect(view.all('[data-todo-row]')).toHaveLength(2);
  expect(view.find('[data-todos-waiting-count]')?.textContent).toContain('6 messages');
  expect(server.requests('/task/todos')).toHaveLength(before + 1);
  expect(server.requests('/task/todos').at(-1)?.body).toStrictEqual(first);
  await view.unmount();
});

it('shares one stream, ignores inbox-only frames, and bounds each dependency to one read', async () => {
  const server = dependentServer();
  const view = await mount(
    <>
      {page(server)}
      {panel(server)}
      {todos(server)}
    </>,
  );
  await tick();
  expect(server.streams()).toHaveLength(1);
  expect(server.streams()[0]).toContain('board');
  expect(server.streams()[0]).toContain(`task:${TASK_ID}`);
  const taskBefore = server.requests('/task/read').length;
  const listBefore = server.requests('/task/todos').length;
  await emit(server, 'inbox');
  expect(server.requests('/task/read')).toHaveLength(taskBefore);
  expect(server.requests('/task/todos')).toHaveLength(listBefore);
  await emit(server);
  expect(server.requests('/task/read')).toHaveLength(taskBefore + 2);
  expect(server.requests('/task/todos')).toHaveLength(listBefore + 1);
  await tick();
  await tick();
  expect(server.requests('/task/read')).toHaveLength(taskBefore + 2);
  expect(server.requests('/task/todos')).toHaveLength(listBefore + 1);
  await act(() => {
    server.taskFrame();
  });
  await tick();
  expect(server.requests('/task/read')).toHaveLength(taskBefore + 4);
  expect(server.requests('/task/todos')).toHaveLength(listBefore + 1);
  await view.unmount();
  await tick();
  expect(server.streams()).toHaveLength(0);
});

it.each(['denied', 'outage'] as const)(
  'withdraws protected task content after %s and ignores an older success',
  async (failure) => {
    const server = dependentServer();
    const view = await mount(page(server));
    await tick();
    expect(view.find('[data-task]')).not.toBeNull();
    server.hold();
    await emit(server);
    server.fail(failure);
    await emit(server);
    expect(view.find('[data-task]')).toBeNull();
    expect(view.text()).toContain(failure === 'denied' ? 'SCOPE_NOT_GRANTED' : 'unavailable');
    await act(() => {
      server.release();
    });
    await tick();
    expect(view.find('[data-task]')).toBeNull();
    await view.unmount();
  },
);

it('cannot restore a departed owner from a held dependent answer', async () => {
  const server = dependentServer();
  const view = await mount(page(server));
  await tick();
  server.hold();
  await emit(server);
  server.fail('denied');
  await view.render(page(server, 'alpha:next-owner'));
  await tick();
  expect(view.find('[data-task]')).toBeNull();
  await act(() => {
    server.release();
  });
  await tick();
  expect(view.find('[data-task]')).toBeNull();
  expect(view.text()).toContain('SCOPE_NOT_GRANTED');
  await view.unmount();
});

it('keeps an unknown subtask envelope intact across B-dependent rank refresh', async () => {
  const server = dependentServer();
  const view = await mount(page(server));
  await tick();
  server.loseCreate();
  await view.type('[data-step-add]', 'One held child');
  const input = field(view, '[data-step-add]');
  await act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await tick();
  expect(server.requests('/task/create')).toHaveLength(1);
  expect(view.text()).toContain('The create answer was lost');
  const first = server.requests('/task/create')[0]?.body;
  expect(first?.['operationId']).toBeTypeOf('string');
  server.change();
  await emit(server);
  expect(rankOf(view)).toBe('#1');
  await view.type('[data-step-add]', 'One held child');
  await act(() => {
    field(view, '[data-step-add]').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  });
  await tick();
  expect(server.requests('/task/create')).toHaveLength(2);
  expect(server.requests('/task/create')[1]?.body).toStrictEqual(first);
  await view.unmount();
});

it('ignores ordinary hidden-page hints but rechecks a closed dependency', async () => {
  const server = dependentServer();
  const view = await mount(page(server));
  await tick();
  const before = server.requests('/task/read').length;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  await emit(server);
  expect(server.requests('/task/read')).toHaveLength(before);
  server.fail('denied');
  await emit(server, 'closed');
  expect(server.requests('/task/read')).toHaveLength(before + 1);
  expect(view.find('[data-task]')).toBeNull();
  await view.unmount();
});

it.each(['page', 'panel'] as const)(
  'does not subscribe an unanswered %s to privileged BOARD',
  async (kind) => {
    const server = dependentServer();
    server.hold();
    const view = await mount(kind === 'page' ? page(server) : panel(server));
    await tick();
    expect(server.streams()).toHaveLength(0);
    await act(() => {
      server.release();
    });
    await tick();
    expect(server.streams()).toHaveLength(1);
    expect(server.streams()[0]).toContain('board');
    await view.unmount();
  },
);
it.each(['page', 'panel'] as const)(
  'does not add BOARD for a delegated full-task %s answer',
  async (kind) => {
    const server = dependentServer();
    server.delegate();
    const view = await mount(kind === 'page' ? page(server) : panel(server));
    await tick();
    expect(rankOf(view)).toBe('#4');
    expect(server.streams()).toHaveLength(1);
    expect(server.streams()[0]).not.toContain('board');
    expect(server.streams()[0]).toContain(`task:${TASK_ID}`);
    const before = server.requests('/task/read').length;
    await emit(server);
    expect(server.requests('/task/read')).toHaveLength(before);
    await act(() => {
      server.taskFrame();
    });
    await tick();
    expect(server.requests('/task/read')).toHaveLength(before + 1);
    await view.unmount();
  },
);
