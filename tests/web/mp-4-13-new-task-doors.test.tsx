// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-13 x DOCK T-17: the ways into a new task on every page. The dock's
// Task tab is on the rail with nothing open, and its press opens a draft filed
// from the page; any `[data-new-task]` control opens the draft through the
// gesture law, prefilled from the door; and the task open in the panel comes
// back after a reload (S1, `aa-task-open`).

import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, type StorageLike } from '../../apps/web/src/session/token.ts';
import { task, tick } from './task-page-stub.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { store } from './draft-support.tsx';

afterEach(unmountAll);

const KEY = 'Proj-Verity-Pacing';
const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };
const TASK = '.dpanel[data-panel-id="task"]';
const TAB = '.dock__tab[data-panel="task"]';
const DOOR = '#perspective-panel-team [data-panel-door="log"]';

function sessions(): SessionStore {
  const held = new Map([['ops-astro.session', JSON.stringify(SESSION)]]);
  const kept: StorageLike = {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  };
  return new SessionStore(kept);
}

const fetch = ((url: string | URL) => {
  const where = String(url);
  if (where.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
  if (where.endsWith('/task/queue')) {
    return Promise.resolve(json({ ok: true, queue: [], alerts: [], outages: [] }));
  }
  if (/\/live(\/task\/|\?|$)/u.test(where)) {
    return Promise.resolve(new Response(null, { status: 404 }));
  }
  if (where.endsWith('/task/read')) return Promise.resolve(json({ ok: true, task: task() }));
  if (where.endsWith('/task/board')) return Promise.resolve(json({ ok: true, tasks: [] }));
  return Promise.resolve(json({ ok: false }));
}) as unknown as typeof globalThis.fetch;

async function app(storage: Storage, path = `/task/${KEY}`) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1100 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
  const view = await mount(
    <App
      path={path}
      navigate={() => {
        /* stays */
      }}
      sessions={sessions()}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={fetch}
      storage={storage}
    />,
  );
  await tick();
  return view;
}

describe('MP-4-13 the dock’s New task is on every page', () => {
  it('with nothing open the Task tab is on the rail, and its press opens a draft filed from the page', async () => {
    const view = await app(store());
    expect(view.host.querySelector(TAB)?.getAttribute('aria-expanded')).toBe('false');
    expect(view.host.querySelector(TASK)).toBeNull();
    await view.click(TAB);
    await tick();
    expect(view.find(`${TASK} [data-draft-panel]`)).not.toBeNull();
    expect(view.find('[data-draft-admission]')?.textContent).toContain(
      'Nothing here to guess from: due in 7 days',
    );
  });
});

describe('MP-4-13 any task-filing control opens the draft through the gesture law', () => {
  it('a data-new-task door opens the Task panel with a draft prefilled from the door', async () => {
    const view = await app(store());
    const door = document.createElement('button');
    door.dataset['newTask'] = 'Checkout down';
    door.dataset['newTaskChannel'] = 'search';
    door.dataset['newTaskLabel'] = 'Search';
    view.host.querySelector('main')?.append(door);
    await view.click('main [data-new-task]');
    await tick();
    expect(view.find(`${TASK} [data-draft-panel]`)).not.toBeNull();
    expect(view.find<HTMLSelectElement>('#panel-draft-category')?.value).toBe('seo');
    expect(view.find('[data-draft-admission]')?.textContent).toContain(
      'New task, filed from Search. Guessed from “Checkout down”, the Search board',
    );
  });
});

describe('MP-4-13 the open task comes back after a reload (S1)', () => {
  it('a task open in the panel is open again after a reload, for the same person', async () => {
    const storage = store();
    const first = await app(storage);
    await first.click(DOOR);
    await tick();
    expect(first.find(`${TASK} [data-task-panel]`)).not.toBeNull();
    await first.unmount();
    const again = await app(storage, '/projects/');
    await tick();
    expect(again.find(`${TASK} [data-task-panel] [data-panel-title]`)?.textContent).toBe(
      'Budget pacing fix',
    );
  });

  it('a task closed before the reload stays closed', async () => {
    const storage = store();
    const first = await app(storage);
    await first.click(DOOR);
    await tick();
    await first.click(`${TASK} [data-act="close"]`);
    await tick();
    await first.unmount();
    const again = await app(storage, '/projects/');
    expect(again.find('[data-task-panel]')).toBeNull();
  });
});
