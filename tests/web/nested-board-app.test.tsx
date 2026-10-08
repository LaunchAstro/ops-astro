// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it } from 'vitest';
import { nestedAppHost } from './nested-task-app-support.tsx';
import { task, tick } from './task-page-stub.tsx';

const item = task({ key: 'Board-child', title: 'Board child', time: null });
const boardItem = Object.assign({}, item, {
  actualMinutes: 0,
  estimateMinutes: null,
  statePosition: null,
  waitReason: null,
  awaitingDecision: false,
  agent: null,
  myAgents: [],
  comments: { client: 0, mentions: 0, latest: null },
});
const panel = (id: string): string => '.dpanel[data-panel-id="' + id + '"]';
const row = 'main tr[data-row="' + item.id + '"]';
async function board() {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1700 });
  const app = await nestedAppHost({
    reply: (sent) =>
      sent.path === '/task/board'
        ? Promise.resolve(Response.json({ ok: true, tasks: [boardItem], viewer: null }))
        : sent.path === '/task/read'
          ? Promise.resolve(Response.json({ ok: true, task: item }))
          : undefined,
  });
  await tick();
  return app;
}
async function fire(element: Element | null, event: Event): Promise<void> {
  if (element === null) throw new Error('Missing actual board door');
  await act(() => {
    element.dispatchEvent(event);
  });
  await tick();
}

it('real App Shift name and subtask doors retain the open dock seat and focus the Team add box', async () => {
  const app = await board();
  await app.view.click('.dock__tab[data-panel="todos"]');
  await tick();
  expect(app.view.find(panel('todos'))).not.toBeNull();
  await fire(
    app.view.find(row + ' .cbd__nm'),
    new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }),
  );
  expect(app.view.find(panel('todos'))).not.toBeNull();
  expect(app.view.find(panel('task'))).not.toBeNull();
  await fire(
    app.view.find(row + ' [data-route="subtask"]'),
    new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }),
  );
  expect(app.view.find(panel('todos'))).not.toBeNull();
  expect(document.activeElement).toBe(app.view.find('[data-task-panel] [data-step-add]'));
  await app.view.click(panel('task') + ' [data-act="close"]');
  expect(document.activeElement).toBe(app.view.find(row + ' [data-route="subtask"]'));
  expect(
    app.sent.filter((sent) =>
      ['/task/create', '/task/complete', '/task/reopen'].includes(sent.path),
    ),
  ).toHaveLength(0);
});

it('row keyboard and blank-cell opening close back to the actual row while plain open replaces the other seat', async () => {
  const app = await board();
  await app.view.click('.dock__tab[data-panel="todos"]');
  await tick();
  const origin = app.view.find(row);
  await fire(
    origin,
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  expect(app.view.find(panel('todos'))).toBeNull();
  await app.view.click(panel('task') + ' [data-act="close"]');
  expect(document.activeElement).toBe(origin);
  await fire(
    app.view.find(row + ' td[data-key="rank"]'),
    new MouseEvent('click', { bubbles: true, cancelable: true }),
  );
  await app.view.click(panel('task') + ' [data-act="close"]');
  expect(document.activeElement).toBe(origin);
  await app.view.click('.dock__tab[data-panel="todos"]');
  await tick();
  await fire(
    origin,
    new KeyboardEvent('keydown', { key: ' ', shiftKey: true, bubbles: true, cancelable: true }),
  );
  expect(app.view.find(panel('todos'))).not.toBeNull();
  expect(app.view.find(panel('task'))).not.toBeNull();
  await app.view.click(panel('task') + ' [data-act="close"]');
  expect(document.activeElement).toBe(origin);
});
