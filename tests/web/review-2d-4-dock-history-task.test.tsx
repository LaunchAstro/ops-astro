// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2D-4 (REVIEW-BATCH #315, batch 2d): the dock's history sticks after
// a task panel. Walking back onto an entry that held `task` (which has no
// panel registration) filters it out, and `apply` records the filtered state
// as a new entry, cutting the forward history (use-dock.ts walk, history.ts
// record). So Back lands on the same place again and Forward goes dead.
//
// Driven: Team tab, a task opened from the page's door, Team and Clients
// stacked beside it, the task's X, then Back twice. The second Back should
// reach the entry where Team stood beside the task, with Forward enabled.

import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, tabStorage, type StorageLike } from '../../apps/web/src/session/token.ts';
import { task, tick } from './task-page-stub.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

const KEY = 'Proj-Verity-Pacing';
const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };
const DOOR = '#perspective-panel-team [data-panel-door="log"]';

function storage(seed: Record<string, string>): StorageLike {
  const held = new Map(Object.entries(seed));
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  };
}

const fetch = ((url: string | URL) => {
  const where = String(url);
  if (where.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
  if (where.endsWith('/task/queue')) {
    return Promise.resolve(json({ ok: true, queue: [], alerts: [], outages: [] }));
  }
  if (where.endsWith('/task/execution')) return Promise.resolve(json({ ok: false }));
  if (/\/live(\/task\/|\?|$)/u.test(where)) {
    return Promise.resolve(new Response(null, { status: 404 }));
  }
  if (where.endsWith('/task/read')) return Promise.resolve(json({ ok: true, task: task() }));
  if (where.endsWith('/task/board')) return Promise.resolve(json({ ok: true, tasks: [] }));
  return Promise.resolve(json({ ok: false }));
}) as unknown as typeof globalThis.fetch;

async function app() {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1700 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
  const view = await mount(
    <App
      path={`/task/${KEY}`}
      navigate={() => {}}
      sessions={new SessionStore(storage({ 'ops-astro.session': JSON.stringify(SESSION) }))}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={fetch}
      storage={tabStorage()}
    />,
  );
  await tick();
  return view;
}

describe('REVIEW-2D-4: dock history after a task panel', () => {
  it('REVIEW-2D-4: Back twice after closing the task reaches Team with Forward enabled', async () => {
    const view = await app();
    const openIds = (): (string | undefined)[] =>
      [...view.host.querySelectorAll<HTMLElement>('.dpanel')].map(
        (each) => each.dataset['panelId'],
      );
    const forward = (): (string | null)[] =>
      [...view.host.querySelectorAll('[data-act="forward"]')].map((each) =>
        each.getAttribute('aria-disabled'),
      );
    const stack = async (id: string): Promise<void> => {
      (view.find(`.dock__tab[data-panel="${id}"]`) as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true, shiftKey: true }),
      );
      await tick();
    };

    await view.click('.dock__tab[data-panel="team"]');
    await tick();
    await view.click(DOOR);
    await tick();
    await stack('team');
    await stack('clients');
    expect(openIds()).toEqual(['team', 'clients', 'task']);
    await view.click('.dpanel[data-panel-id="task"] [data-act="close"]');
    await tick();
    expect(openIds()).toEqual(['team', 'clients']);

    await view.click('.dpanel[data-panel-id="team"] [data-act="back"]');
    await tick();
    await view.click('.dpanel[data-panel-id="team"] [data-act="back"]');
    await tick();
    expect(openIds()).toContain('team');
    expect(forward()).not.toContain('true');
    expect(openIds()).not.toContain('clients');
  });
});
