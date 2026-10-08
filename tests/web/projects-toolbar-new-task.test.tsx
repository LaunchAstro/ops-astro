// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, expect, it } from 'vitest';
import { readDraft, dropOtherDrafts } from '../../apps/web/src/screens/task/task-draft.ts';
import { mount } from '../surfaces/mount.tsx';
import { draftApp, commands, PERSON, tick } from './projects-draft-app-support.tsx';

beforeEach(() => window.history.replaceState(null, '', '/projects/'));

it('Projects New task opens the shared untimed draft and restores its kept fields after owner reload', async () => {
  const app = await draftApp();
  await app.view.click('[data-projects-new-task]');
  const title = app.view.host.querySelector('#panel-draft-name');
  expect(title).toBeInstanceOf(HTMLInputElement);
  expect(document.activeElement).toBe(title);
  expect(readDraft(app.storage, PERSON)).toBeNull();
  await app.view.type('#panel-draft-name', 'Kept Projects draft');
  expect(readDraft(app.storage, PERSON)).toMatchObject({
    from: 'Projects',
    clientId: null,
    timerFrom: null,
  });
  expect(commands(app.sent)).toEqual([]);
  await app.view.click('.dpanel[data-panel-id="task"] [data-act="close"]');
  await app.view.unmount();
  dropOtherDrafts(null, null);
  const restored = await mount(app.element);
  await restored.click('[data-projects-new-task]');
  const kept = restored.host.querySelector<HTMLInputElement>('#panel-draft-name');
  expect(kept?.value).toBe('Kept Projects draft');
  expect(commands(app.sent)).toEqual([]);
});

it('Projects New task recovers an unknown Create without starting a timer or changing the held operation', async () => {
  let lose = true;
  const loseAnswer = (): Promise<Response> => {
    lose = false;
    return Promise.reject(new TypeError('Lost answer'));
  };
  const app = await draftApp({
    reply: (sent) => (sent.path === '/task/create' && lose ? loseAnswer() : undefined),
  });
  await app.view.click('[data-projects-new-task]');
  await app.view.type('#panel-draft-name', 'Projects unknown Create');
  await app.view.click('[data-draft="create"]');
  await tick();
  const held = readDraft(app.storage, PERSON);
  const first = app.sent.find((sent) => sent.path === '/task/create')?.body;
  expect(first).toBeDefined();
  await app.view.click('.dpanel[data-panel-id="task"] [data-act="close"]');
  await app.view.unmount();
  dropOtherDrafts(null, null);
  const restored = await mount(app.element);
  await restored.click('[data-projects-new-task]');
  expect(readDraft(app.storage, PERSON)).toEqual(held);
  await restored.click('[data-draft="create"]');
  await tick();
  expect(app.sent.filter((sent) => sent.path === '/task/create').map((sent) => sent.body)).toEqual([
    first,
    first,
  ]);
  expect(
    commands(app.sent).some((sent) =>
      ['/time/start', '/time/stop', '/time/log'].includes(sent.path),
    ),
  ).toBe(false);
  expect(readDraft(app.storage, PERSON)).toBeNull();
});

it('Projects withdraws New task on Work log and exposes no door when signed out', async () => {
  const app = await draftApp();
  expect(app.view.host.querySelector('[data-projects-new-task]')).not.toBeNull();
  await app.view.click('[role="tab"][id$="worklog"]');
  expect(app.view.host.querySelector('[data-projects-new-task]')).toBeNull();
  await app.view.unmount();
  app.storage.removeItem('ops-astro.session');
  const signedOut = await draftApp({ storage: app.storage });
  expect(signedOut.view.host.querySelector('[data-projects-new-task]')).toBeNull();
});

it.each([false, true])(
  'Projects New task follows the dock gesture law for Shift %s',
  async (shiftKey) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1700 });
    const app = await draftApp();
    await app.view.click('.dock__tab[data-panel="todos"]');
    expect(app.view.find('.dpanel[data-panel-id="todos"]')).not.toBeNull();
    const door = app.view.find('main [data-projects-new-task]');
    expect(door).not.toBeNull();
    await act(() => {
      door?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey }));
    });
    expect(app.view.find('.dpanel[data-panel-id="task"] [data-draft-panel]')).not.toBeNull();
    expect(app.view.find('.dpanel[data-panel-id="todos"]') !== null).toBe(shiftKey);
    expect(commands(app.sent)).toEqual([]);
  },
);

it('the existing task-filing gesture keeps an open panel beside a Shift draft', async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1700 });
  const app = await draftApp();
  await app.view.click('.dock__tab[data-panel="todos"]');
  const door = document.createElement('button');
  door.dataset['newTask'] = '';
  door.dataset['newTaskLabel'] = 'Projects';
  app.view.find('main')?.append(door);
  await act(() => {
    door.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }),
    );
  });
  expect(app.view.find('.dpanel[data-panel-id="task"] [data-draft-panel]')).not.toBeNull();
  expect(app.view.find('.dpanel[data-panel-id="todos"]')).not.toBeNull();
  expect(commands(app.sent)).toEqual([]);
});
