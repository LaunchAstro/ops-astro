// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it } from 'vitest';
import { nestedAppHost, nestedTab, type Sent } from './nested-task-app-support.tsx';
import { task, tick } from './task-page-stub.tsx';
import type { Mounted } from '../surfaces/mount.tsx';
import type { StepView } from '../../packages/core-wire/src/index.ts';

const PARENT = '22222222-2222-4222-8222-222222222222';
const CHILD = '33333333-3333-4333-8333-333333333333';
const GRANDCHILD = '44444444-4444-4444-8444-444444444444';
const step = (id: string, key: string, title: string): StepView => ({
  id,
  key,
  title,
  state: null,
  done: false,
  archived: null,
  awaitingApproval: false,
  assignee: null,
  revision: 1,
});
const reply = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function createdChild(sent: Sent, committed: () => void): Promise<Response> {
  expect(sent.body['parentId']).toBe(CHILD);
  expect(sent.body['fields']).toStrictEqual({ title: 'Grandchild task' });
  committed();
  return Promise.resolve(
    reply({ recordId: GRANDCHILD, revision: 1, detail: { key: 'nested-grandchild' } }),
  );
}

function nestedApp(storage: Storage): Promise<Awaited<ReturnType<typeof nestedAppHost>>> {
  let created = false;
  return nestedAppHost({
    storage,
    path: '/task/nested-parent',
    reply: (sent) => {
      if (sent.path === '/task/read') {
        const key = sent.body['recordId'];
        const identity =
          key === 'nested-parent'
            ? {
                id: PARENT,
                key,
                title: 'Parent task',
                steps: [step(CHILD, 'nested-child', 'Child task')],
              }
            : key === 'nested-child'
              ? {
                  id: CHILD,
                  key,
                  title: 'Child task',
                  steps: created ? [step(GRANDCHILD, 'nested-grandchild', 'Grandchild task')] : [],
                }
              : key === 'nested-grandchild'
                ? { id: GRANDCHILD, key, title: 'Grandchild task', steps: [] }
                : null;
        return Promise.resolve(
          reply(
            identity === null
              ? { refused: true, code: 'NOT_FOUND', names: ['task'], fixes: [] }
              : { ok: true, task: task({ ...identity, time: null }) },
          ),
        );
      }
      return sent.path === '/task/create'
        ? createdChild(sent, () => {
            created = true;
          })
        : undefined;
    },
  });
}

const panelTask = (view: Mounted): string | undefined =>
  view.host.querySelector<HTMLElement>('[data-task-panel] [data-task]')?.dataset['task'];

it('opens real App child and grandchild panels, creates under the child, and reopens each level from its read', async () => {
  const storage = nestedTab();
  const app = await nestedApp(storage);
  await tick();
  await app.view.click('main a.sb__step-title');
  await tick();
  expect(panelTask(app.view)).toBe(CHILD);
  await app.view.type('[data-task-panel] [data-step-add]', 'Grandchild task');
  await act(() => {
    app.view
      .find('[data-task-panel] [data-step-add]')
      ?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
  });
  await tick();
  expect(app.view.find('[data-task-panel] [data-step-count]')?.textContent).toBe(
    '0 of 1 done · 0%',
  );
  await app.view.click('[data-task-panel] a.sb__step-title');
  await tick();
  expect(panelTask(app.view)).toBe(GRANDCHILD);
  await app.view.click('main a.sb__step-title');
  await tick();
  expect(panelTask(app.view)).toBe(CHILD);
  expect(app.view.find('[data-task-panel] a.sb__step-title')?.textContent).toBe('Grandchild task');
  await app.view.click('main [data-panel-door="open"]');
  await tick();
  expect(panelTask(app.view)).toBe(PARENT);
  expect(app.view.find('[data-task-panel] a.sb__step-title')?.textContent).toBe('Child task');
  expect(app.sent.filter((s) => s.path === '/task/create')).toHaveLength(1);
  expect(app.sent.filter((s) => ['/task/complete', '/task/reopen'].includes(s.path))).toHaveLength(
    0,
  );
  await app.view.unmount();
  const reloaded = await nestedApp(storage);
  await tick();
  expect(panelTask(reloaded.view)).toBe(PARENT);
});

it('opens a child through normal task.read and displays refusal without child data or a create box', async () => {
  const app = await nestedAppHost({
    path: '/task/nested-parent',
    reply: (sent) =>
      sent.path === '/task/read'
        ? Promise.resolve(
            reply(
              sent.body['recordId'] === 'nested-parent'
                ? {
                    ok: true,
                    task: task({
                      id: PARENT,
                      key: 'nested-parent',
                      steps: [step(CHILD, 'nested-child', 'Child task')],
                    }),
                  }
                : {
                    refused: true,
                    code: 'SCOPE_NOT_GRANTED',
                    names: ['task'],
                    fixes: ['ask the owner'],
                  },
            ),
          )
        : undefined,
  });
  await tick();
  await app.view.click('main a.sb__step-title');
  await tick();
  expect(
    app.sent.some((s) => s.path === '/task/read' && s.body['recordId'] === 'nested-child'),
  ).toBe(true);
  expect(app.view.find('[data-task-panel] [data-task]')).toBeNull();
  expect(app.view.find('[data-task-panel] [data-step-add]')).toBeNull();
  expect(app.view.find('[data-task-panel]')?.textContent).toContain('ask the owner');
});

it('a truly empty task page opens the real first-step action and focuses its panel add box', async () => {
  const app = await nestedAppHost({
    path: '/task/empty-parent',
    reply: (sent) =>
      sent.path === '/task/read'
        ? Promise.resolve(
            reply({
              ok: true,
              task: task({ id: PARENT, key: 'empty-parent', steps: [], time: null }),
            }),
          )
        : undefined,
  });
  await tick();
  expect(app.view.find('main [data-steps]')?.textContent).toContain('No subtasks on this one yet.');
  await app.view.click('main [data-panel-door="add-first"]');
  await tick();
  expect(panelTask(app.view)).toBe(PARENT);
  expect(document.activeElement).toBe(app.view.find('[data-task-panel] [data-step-add]'));
  expect(app.sent.filter((sent) => sent.path === '/task/create')).toHaveLength(0);
});

it.each(['pointer', 'Enter'])(
  'closing a child opened by %s returns focus to its exact page title',
  async (gesture) => {
    const app = await nestedApp(nestedTab());
    await tick();
    const origin = app.view.host.querySelector<HTMLAnchorElement>('main a.sb__step-title');
    expect(origin).not.toBeNull();
    await act(() => origin?.focus());
    if (gesture === 'pointer') await app.view.click('main a.sb__step-title');
    else
      await act(() => {
        origin?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        );
      });
    await tick();
    expect(panelTask(app.view)).toBe(CHILD);
    await app.view.click('.dpanel[data-panel-id="task"] [data-act="close"]');
    await tick();
    expect(app.view.find('[data-task-panel]')).toBeNull();
    expect(document.activeElement).toBe(origin);
    expect(
      app.sent.filter((sent) =>
        ['/task/create', '/task/complete', '/task/reopen'].includes(sent.path),
      ),
    ).toEqual([]);
  },
);
