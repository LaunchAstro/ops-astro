// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { ProjectsBoard } from '../../packages/ui/src/surfaces/ProjectsBoard.tsx';
import type { ProjectRow, RowActions } from '../../packages/ui/src/board/projects.ts';
import { rowActions } from '../../apps/web/src/screens/projects-row.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const row: ProjectRow = {
  id: '11111111-1111-4111-8111-111111111111',
  key: 'T-1',
  name: 'A task',
  rank: { number: 3, calc: '' },
  starred: false,
  client: null,
  assignee: null,
  due: null,
  completed: false,
  stage: null,
  status: 'Active',
  statusPosition: 1,
  waitReason: null,
  category: null,
  awaitingDecision: false,
  estimate: null,
  actual: null,
  comments: { client: 0, mentions: 0, latest: null },
};
const open = (actions: RowActions) =>
  mount(
    <ProjectsBoard
      rows={[row]}
      withheld={0}
      stages={[]}
      href={() => '/task/T-1'}
      width={1400}
      viewport={1480}
      actions={actions}
    />,
  );
const fire = async (target: Element | null, event: Event) => {
  if (target === null) throw new Error('Missing actual control');
  await act(() => {
    target.dispatchEvent(event);
  });
};

it('blank row cells and keyboard activation open once, while interactive cells keep their own action', async () => {
  const opened = vi.fn();
  const ticked = vi.fn();
  const view = await open({ onOpen: opened, onTick: ticked });
  const tr = view.find('tr[data-row]');
  expect(tr?.getAttribute('tabindex')).toBe('0');
  await fire(
    view.find('tr[data-row] td[data-key="rank"]'),
    new MouseEvent('click', { bubbles: true }),
  );
  expect(opened.mock.calls).toStrictEqual([[row, false, 'row']]);
  opened.mockClear();
  await fire(tr, new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await fire(
    tr,
    new KeyboardEvent('keydown', { key: ' ', shiftKey: true, bubbles: true, cancelable: true }),
  );
  expect(opened.mock.calls).toStrictEqual([
    [row, false, 'row'],
    [row, true, 'row'],
  ]);
  opened.mockClear();
  await view.click('.cbd__tick');
  expect(ticked).toHaveBeenCalledOnce();
  expect(opened).not.toHaveBeenCalled();
  await fire(
    view.find('.cbd__tick'),
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
  );
  expect(opened).not.toHaveBeenCalled();
  const cell = view.find('tr[data-row] td[data-key="rank"]');
  cell?.addEventListener('click', (event) => event.preventDefault(), { once: true });
  await fire(cell, new MouseEvent('click', { bubbles: true, cancelable: true }));
  expect(opened).not.toHaveBeenCalled();
});

it('Shift name and subtask doors open beside without navigation or a second row activation', async () => {
  const opened = vi.fn();
  const added = vi.fn();
  const view = await open({ onOpen: opened, onAddSubtask: added });
  const nameEvent = new MouseEvent('click', { shiftKey: true, bubbles: true, cancelable: true });
  await fire(view.find('.cbd__nm'), nameEvent);
  expect(nameEvent.defaultPrevented).toBe(true);
  expect(opened.mock.calls).toStrictEqual([[row, true]]);
  const addEvent = new MouseEvent('click', { shiftKey: true, bubbles: true, cancelable: true });
  await fire(view.find('[data-route="subtask"]'), addEvent);
  expect(addEvent.defaultPrevented).toBe(true);
  expect(added.mock.calls).toStrictEqual([[row, true]]);
  expect(opened).toHaveBeenCalledOnce();
  const nativeEvent = new MouseEvent('click', { ctrlKey: true, bubbles: true, cancelable: true });
  await fire(view.find('.cbd__nm'), nativeEvent);
  expect(nativeEvent.defaultPrevented).toBe(false);
  expect(opened).toHaveBeenCalledOnce();
});

it('real row adapters carry beside and subtask focus doors without sending domain commands', () => {
  const fetch = vi.fn();
  const host = { open: vi.fn(), changes: 0 };
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
    newOperationId: () => 'operation-1',
  });
  const actions = rowActions({
    client,
    people: null,
    href: () => '/task/T-1',
    reload: vi.fn(),
    onSettled: vi.fn(),
    panel: { host, opened: null, setOpened: vi.fn() },
  });
  actions.onOpen?.(row, true);
  actions.onAddSubtask?.(row, true);
  expect(host.open.mock.calls).toStrictEqual([
    ['T-1', 'open', undefined, true],
    ['T-1', 'add-first', undefined, true],
  ]);
  expect(fetch).not.toHaveBeenCalled();
});
