// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { realm } from './task-timer-recovery-support.tsx';
import { draftTab } from './projects-draft-app-support.tsx';
import { chooseMark, KEY, marksWorld } from './p08-rank-marks-support.tsx';
const SLOT = 'ops-astro.task-scores';

it.each(['throw', 'drop', 'omit', 'read-fail'] as const)(
  'actual App refuses sending when complete custody readback is %s',
  async (failure) => {
    const storage = draftTab();
    const set = storage.setItem.bind(storage);
    const get = storage.getItem.bind(storage);
    let blocked = true;
    storage.setItem = (key, value) => {
      if (key === SLOT && blocked) {
        if (failure === 'throw') throw new Error('Write refused');
        if (failure === 'drop') return;
        if (failure === 'omit') value = value.replace(',"value":10', '');
      }
      set(key, value);
    };
    storage.getItem = (key) => {
      if (key === SLOT && blocked && failure === 'read-fail') throw new Error('Read refused');
      return get(key);
    };
    const server = marksWorld();
    const app = await realm(server.fetch, storage, '/task/' + KEY);
    await chooseMark(app.view, 'page', 'impact', '10');
    expect(server.writes()).toEqual([]);
    expect(app.view.text()).toContain('No score change was sent');
    expect(app.view.find('[data-score-retry]')).not.toBeNull();
    blocked = false;
    await app.view.click('[data-score-retry]');
    expect(server.writes()).toHaveLength(1);
    expect(server.writes()[0]?.body).toMatchObject({ expectedRevision: 4, fields: { impact: 10 } });
    expect(server.effects()).toBe(1);
    expect(server.unexpected).toEqual([]);
  },
);

it('confirmed success with cleanup failure blocks a new intent and cleanup sends no command', async () => {
  const storage = draftTab();
  const set = storage.setItem.bind(storage);
  let blocked = true;
  storage.setItem = (key, value) => {
    if (key === SLOT && blocked && value.includes('"tasks":{}')) throw new Error('Cleanup refused');
    set(key, value);
  };
  const server = marksWorld();
  const app = await realm(server.fetch, storage, '/task/' + KEY);
  await chooseMark(app.view, 'page', 'impact', '10');
  expect(server.effects()).toBe(1);
  expect(app.view.find('#page-score-ease button')).toHaveProperty('disabled', true);
  expect(app.view.text()).toContain('Retry score recovery cleanup');
  blocked = false;
  await app.view.click('[data-score-retry]');
  expect(server.writes()).toHaveLength(1);
  expect(app.view.find('#page-score-ease button')).toHaveProperty('disabled', false);
  expect(server.unexpected).toEqual([]);
});

it('each memory-only score attempt requires an explicit App choice', async () => {
  const storage = draftTab();
  const set = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (key === SLOT) throw new Error('Storage refused');
    set(key, value);
  };
  const server = marksWorld();
  const app = await realm(server.fetch, storage, '/task/' + KEY);
  await chooseMark(app.view, 'page', 'impact', '10');
  expect(server.writes()).toEqual([]);
  const send = () =>
    app.view.all('button').find((one) => one.textContent === 'Send without reload recovery') as
      HTMLButtonElement | undefined;
  expect(send()).toBeDefined();
  await app.act(() => send()?.click());
  expect(server.writes()).toHaveLength(1);
  expect(app.view.text()).toContain('Memory-only score recovery');
  await chooseMark(app.view, 'page', 'ease', '3');
  expect(server.writes()).toHaveLength(1);
  expect(send()).toBeDefined();
  await app.act(() => send()?.click());
  expect(server.writes()).toHaveLength(2);
  expect(server.effects()).toBe(2);
  expect(server.unexpected).toEqual([]);
});

it('write refusal still permits an exact retry when the already durable custody remains verified', async () => {
  const server = marksWorld('lost-after');
  const app = await realm(server.fetch, draftTab(), '/task/' + KEY);
  await chooseMark(app.view, 'page', 'impact', '10');
  const original = server.writes()[0]?.body;
  const set = app.storage.setItem.bind(app.storage);
  app.storage.setItem = (key, value) => {
    if (key === SLOT) throw new Error('Write refused but original durable bytes remain');
    set(key, value);
  };
  await app.view.click('[data-score-retry]');
  expect(server.writes()).toHaveLength(2);
  expect(server.writes()[1]?.body).toEqual(original);
  expect(server.effects()).toBe(1);
  expect(app.view.text()).not.toContain('may already have been stored');
  expect(app.view.text()).toContain('Retry score recovery cleanup');
  expect(server.unexpected).toEqual([]);
});

it('blocked readback after a lost-after score answer truthfully says only its retry was not sent', async () => {
  const server = marksWorld('lost-after');
  const app = await realm(server.fetch, draftTab(), '/task/' + KEY);
  await chooseMark(app.view, 'page', 'impact', '10');
  const original = server.writes()[0]?.body;
  const get = app.storage.getItem.bind(app.storage);
  const set = app.storage.setItem.bind(app.storage);
  const exactKept = get(SLOT);
  expect(exactKept).toContain(String(original?.['operationId']));
  app.storage.getItem = (key) => {
    if (key === SLOT) throw new Error('Readback refused');
    return get(key);
  };
  app.storage.setItem = (key, value) => {
    if (key === SLOT) throw new Error('Write refused');
    set(key, value);
  };
  await app.view.click('[data-score-retry]');
  expect(server.writes()).toHaveLength(1);
  expect(server.writes()[0]?.body).toEqual(original);
  expect(server.effects()).toBe(1);
  expect(get(SLOT)).toBe(exactKept);
  expect(app.view.find('[data-score-retry]')).not.toBeNull();
  expect(app.view.find('#page-score-ease button')).toHaveProperty('disabled', true);
  expect(app.view.text()).toContain('may already have been stored');
  expect(app.view.text()).toContain('No retry was sent.');
  expect(app.view.text()).not.toContain('No score change was sent.');
  app.storage.getItem = get;
  app.storage.setItem = set;
  await app.view.click('[data-score-retry]');
  expect(server.writes()).toHaveLength(2);
  expect(server.writes()[1]?.body).toEqual(original);
  expect(server.effects()).toBe(1);
  expect(app.view.find('[data-score-retry]')).toBeNull();
  expect(server.unexpected).toEqual([]);
});
