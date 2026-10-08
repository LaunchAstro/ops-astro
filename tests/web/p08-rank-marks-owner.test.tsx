// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { copied, realm } from './task-timer-recovery-support.tsx';
import { draftTab } from './projects-draft-app-support.tsx';
import { chooseMark, KEY, marksWorld } from './p08-rank-marks-support.tsx';
const SLOT = 'ops-astro.task-scores';
const noReply = () => {};

it('same-owner transport rotation fences a late success and retries the original envelope', async () => {
  const server = marksWorld();
  let release = noReply;
  const delayed: typeof globalThis.fetch = (url, init) => {
    const answer = server.fetch(url, init);
    return String(url).endsWith('/task/set_scores')
      ? new Promise<Response>((resolve) => {
          release = () => void answer.then(resolve);
        })
      : answer;
  };
  const app = await realm(delayed, draftTab(), '/task/' + KEY);
  await chooseMark(app.view, 'page', 'impact', '10');
  const original = server.writes()[0]?.body;
  await app.renderFetch(server.fetch);
  expect(app.view.find('[data-score-retry]')).not.toBeNull();
  await app.act(release);
  await app.tick();
  expect(app.view.find('[data-score-retry]')).not.toBeNull();
  await app.view.click('[data-score-retry]');
  expect(server.writes()[1]?.body).toEqual(original);
  expect(server.effects()).toBe(1);
  expect(server.unexpected).toEqual([]);
});

it.each([false, true])(
  'owner departure cannot resurrect old score custody after A→B→A even if removal fails=%s',
  async (removalFails) => {
    const server = marksWorld('lost-after');
    const app = await realm(server.fetch, draftTab(), '/task/' + KEY);
    await chooseMark(app.view, 'page', 'impact', '10');
    expect(app.storage.getItem(SLOT)).not.toBeNull();
    const remove = app.storage.removeItem.bind(app.storage);
    app.storage.removeItem = (key) => {
      if (key === SLOT && removalFails) throw new Error('Removal refused');
      remove(key);
    };
    const home = app.sessions.session!;
    await app.act(() => {
      app.sessions.set({ ...home, businessKey: 'bravo' });
      app.sessions.set(home);
    });
    await app.renderFetch((url, init) => server.fetch(url, init));
    expect(app.view.find('[data-score-retry]')).toBeNull();
    const storage = copied(app.storage);
    await app.view.unmount();
    const next = await realm(server.fetch, storage, '/task/' + KEY);
    expect(next.view.find('[data-score-retry]')).toBeNull();
    expect(server.writes()).toHaveLength(1);
    expect(server.unexpected).toEqual([]);
  },
);

it('current read denial withdraws the editor while exact unknown custody survives frame lifetime', async () => {
  const server = marksWorld('lost-after');
  const app = await realm(server.fetch, draftTab(), '/task/' + KEY);
  await chooseMark(app.view, 'page', 'impact', '10');
  const original = server.writes()[0]?.body;
  server.denyRead(true);
  await app.view.click('[data-refresh="task"]');
  expect(app.view.find('#page-score-impact button')).toBeNull();
  expect(app.view.text()).not.toContain('Budget pacing fix');
  expect(server.writes()).toHaveLength(1);
  server.denyRead(false);
  await app.view.click('[data-refresh="task"]');
  expect(app.view.find('[data-score-retry]')).not.toBeNull();
  await app.view.click('[data-score-retry]');
  expect(server.writes()[1]?.body).toEqual(original);
  expect(server.effects()).toBe(1);
  expect(server.unexpected).toEqual([]);
});

it.each(['json', 'version', 'extra', 'revision', 'operation', 'value', 'task-id', 'owner'])(
  'corrupt or foreign %s stored score envelope sends nothing',
  async (corruption) => {
    const server = marksWorld('lost-after');
    const first = await realm(server.fetch, draftTab(), '/task/' + KEY);
    await chooseMark(first.view, 'page', 'impact', '10');
    const storage = copied(first.storage);
    const saved = JSON.parse(storage.getItem(SLOT)!);
    const attempt = Object.values(saved.tasks)[0] as Record<string, unknown>;
    if (corruption === 'version') saved.version = 2;
    if (corruption === 'extra') attempt['ignored'] = true;
    if (corruption === 'revision') attempt['revision'] = 0;
    if (corruption === 'operation') attempt['operationId'] = 'bad';
    if (corruption === 'value') attempt['value'] = 2.5;
    if (corruption === 'task-id') saved.tasks = { hidden: attempt };
    if (corruption === 'owner') saved.owner = 'other-owner';
    storage.setItem(SLOT, corruption === 'json' ? '{broken' : JSON.stringify(saved));
    await first.view.unmount();
    const next = await realm(server.fetch, storage, '/task/' + KEY);
    expect(next.view.find('[data-score-retry]')).toBeNull();
    expect(server.writes()).toHaveLength(1);
    expect(server.unexpected).toEqual([]);
  },
);
