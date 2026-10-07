// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-13 x DOCK T-17: the ways into a new task on every page. The dock's
// Task tab is on the rail with nothing open, and its press opens a draft filed
// from the page; any `[data-new-task]` control opens the draft through the
// gesture law, prefilled from the door; and the task open in the panel comes
// back after a reload (S1, `aa-task-open`).

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, type StorageLike } from '../../apps/web/src/session/token.ts';
import { task, tick } from './task-page-stub.tsx';
import { json, mount, typeInto, unmountAll } from './perspective-support.tsx';
import { store } from './draft-support.tsx';

afterEach(() => {
  unmountAll();
  sent.length = 0;
});

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

/** What the app sent to the task and time commands, in order. */
const sent: { readonly to: string; readonly body: Record<string, unknown> }[] = [];

const fetch = ((url: string | URL, init?: RequestInit) => {
  const where = String(url);
  const write = /\/(task\/(create|set_party|set_category|assign))$/u.exec(where)?.[1];
  if (write !== undefined) {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    sent.push({ to: write, body });
    return Promise.resolve(json({ recordId: 'r-new', revision: 1, detail: { key: 'Proj-New' } }));
  }
  if (where.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
  if (where.endsWith('/client/list')) return Promise.resolve(json({ ok: true, clients: [] }));
  if (where.endsWith('/task/todos')) return Promise.resolve(json({ ok: true, todos: [] }));
  if (where.endsWith('/task/queue')) {
    return Promise.resolve(json({ ok: true, queue: [], alerts: [], outages: [] }));
  }
  if (/\/live(\/task\/|\?|$)/u.test(where)) {
    return Promise.resolve(new Response(null, { status: 404 }));
  }
  if (where.endsWith('/task/read')) return Promise.resolve(json({ ok: true, task: task() }));
  if (where.endsWith('/inbox/read')) return Promise.resolve(json({ ok: true, inbox: [] }));
  if (where.endsWith('/inbox/count')) return Promise.resolve(json({ ok: true, owed: 0 }));
  if (where.endsWith('/task/board')) return Promise.resolve(json({ ok: true, tasks: [] }));
  return Promise.resolve(json({ ok: false }));
}) as unknown as typeof globalThis.fetch;

async function app(storage: Storage, path = `/task/${KEY}`, width = 1100) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
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
  it('the Projects (to-dos) panel’s head New opens a draft filed from the page, and the rail keeps its doors', async () => {
    const view = await app(store());
    expect(view.host.querySelector(TAB)).toBeNull();
    await view.click('.dock__tab[data-panel="todos"]');
    await tick();
    await view.click('.dpanel[data-panel-id="todos"] [data-act="new"]');
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
    expect((view.find('#panel-draft-category') as HTMLSelectElement | null)?.value).toBe('seo');
    expect(view.find('[data-draft-admission]')?.textContent).toContain(
      'New task, filed from Search. Guessed from “Checkout down”, the Search board',
    );
  });
});

const doorFor = (
  view: Awaited<ReturnType<typeof app>>,
  subject: string,
  data: Record<string, string>,
) => {
  const door = document.createElement('button');
  door.dataset['newTask'] = subject;
  for (const [key, value] of Object.entries(data)) door.dataset[key] = value;
  view.host.querySelector('main')?.append(door);
  return door;
};

describe('MP-4-13 each door files its own draft', () => {
  it('a second door replaces an untouched draft’s guesses, client included', async () => {
    const view = await app(store());
    const first = doorFor(view, 'A thing', { newTaskChannel: 'search', newTaskClient: 'c-a' });
    first.click();
    await tick();
    first.remove();
    const second = doorFor(view, 'B thing', {
      newTaskChannel: 'ads',
      newTaskLabel: 'Ads',
      newTaskClient: 'c-b',
    });
    second.click();
    await tick();
    expect((view.find('#panel-draft-category') as HTMLSelectElement | null)?.value).toBe(
      'paid-ads',
    );
    expect(view.find('[data-draft-admission]')?.textContent).toContain(
      'filed from Ads. Guessed from “B thing”, the Ads board',
    );
    await typeInto(view, '#panel-draft-name', 'From B');
    await view.click('[data-draft="create"]');
    for (let settle = 0; settle < 8; settle += 1) {
      // eslint-disable-next-line no-await-in-loop -- the chain is one request at a time
      await tick();
    }
    expect(sent.find((one) => one.to === 'task/set_party')?.body).toMatchObject({
      fields: { client: 'c-b' },
    });
  });

  it('a kept draft reopened from another door still says where it was filed from', async () => {
    const view = await app(store());
    const first = doorFor(view, 'A thing', { newTaskChannel: 'search', newTaskLabel: 'Search' });
    first.click();
    await tick();
    first.remove();
    await typeInto(view, '#panel-draft-name', 'Kept');
    doorFor(view, 'B thing', { newTaskChannel: 'ads', newTaskLabel: 'Ads' }).click();
    await tick();
    expect((view.find('#panel-draft-name') as HTMLInputElement | null)?.value).toBe('Kept');
    expect(view.find('[data-draft-admission]')?.textContent).toContain(
      'filed from Search. Guessed from “A thing”, the Search board',
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

  it('the task comes back beside the panels open with it, and the kept dock keeps them all', async () => {
    const storage = store();
    const first = await app(storage, `/task/${KEY}`, 1700);
    await first.click(DOOR);
    await tick();
    const notifs = first.find('.dock__tab[data-panel="notifs"]');
    await act(async () => {
      notifs?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
      await Promise.resolve();
    });
    await tick();
    expect(first.find('.dpanel[data-panel-id="notifs"]')).not.toBeNull();
    expect(first.find(TASK)).not.toBeNull();
    await first.unmount();
    const again = await app(storage, '/projects/', 1700);
    await tick();
    expect(again.find(`${TASK} [data-task-panel]`)).not.toBeNull();
    expect(again.find('.dpanel[data-panel-id="notifs"]')).not.toBeNull();
    const kept = JSON.parse(storage.getItem('ops-astro.dock.alpha') ?? '{}') as { open?: unknown };
    expect(kept.open).toEqual(expect.arrayContaining(['task', 'notifs']));
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
