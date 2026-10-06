// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-3-1 x MP-4-8: the dock draws the task panel as its own `task` panel
// (DOCK.md section 2, row 6: Task, list-check). A task opened from a page
// door draws inside the dock with one head, the dock's; its tab shows while
// it is open; the dock's close, Close all and Escape close it through the
// task panel's own close, which draws no button of its own beside the
// dock's X; on a phone one panel draws, the one opened last;
// seated, the group's track counts it; the new-task draft takes the same
// panel. A link inside it is the task panel's, never a walk of the dock.

import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, tabStorage, type StorageLike } from '../../apps/web/src/session/token.ts';
import { task, tick } from './task-page-stub.tsx';
import { json, mount, typeInto, unmountAll } from './perspective-support.tsx';

afterEach(() => {
  unmountAll();
  // The open task is kept in the tab's storage across a reload (S1): each test starts clean.
  window.sessionStorage.clear();
});

const KEY = 'Proj-Verity-Pacing';
const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };
const TASK = '.dpanel[data-panel-id="task"]';
const TAB = '.dock__tab[data-panel="task"]';
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
  // The panel's Project select reads the Projects board (MP-4-8).
  if (where.endsWith('/task/board')) return Promise.resolve(json({ ok: true, tasks: [] }));
  return Promise.resolve(json({ ok: false }));
}) as unknown as typeof globalThis.fetch;

async function app(width = 1100, went: string[] = []) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
  const view = await mount(
    <App
      path={`/task/${KEY}`}
      navigate={(to) => {
        went.push(to);
      }}
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

async function opened(width = 1100, went: string[] = []) {
  const view = await app(width, went);
  await view.click(DOOR);
  await tick();
  return view;
}

const escape = (): void => {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
};

describe('MP-3-1 the dock draws the task panel as its Task panel', () => {
  it('no Task tab and no Task panel until a task is opened', async () => {
    const view = await app();
    expect(view.host.querySelector(TAB)).toBeNull();
    expect(view.host.querySelector(TASK)).toBeNull();
  });

  it('a task opened from a page door draws inside the dock, with its tab, under one head', async () => {
    const view = await opened();
    expect(view.find(`${TASK} [data-task-panel] [data-panel-title]`)?.textContent).toBe(
      'Budget pacing fix',
    );
    expect(view.host.querySelectorAll('[data-task-panel]')).toHaveLength(1);
    expect(view.host.querySelector(TAB)?.getAttribute('aria-expanded')).toBe('true');
    expect(view.host.querySelector(TAB)?.getAttribute('aria-label')).toBe('Close Task');
    // One head: the dock's, naming the panel and never the task in it (DK-08).
    expect(view.host.querySelectorAll(`${TASK} .dpanel__head`)).toHaveLength(1);
    expect(view.find(`${TASK} .dpanel__name`)?.textContent).toBe('Task');
    // Its door is the task's own page.
    expect(view.find(`${TASK} [data-act="door"]`)?.getAttribute('href')).toBe(`/task/${KEY}`);
  });
});

describe('MP-3-1 the Task panel closes from either side', () => {
  it("the dock's close closes it through the task panel's close, focus back on the door", async () => {
    const view = await opened();
    await view.click(`${TASK} [data-act="close"]`);
    await tick();
    expect(view.find('[data-task-panel]')).toBeNull();
    expect(view.host.querySelector(TAB)).toBeNull();
    expect(document.activeElement).toBe(view.host.querySelector(DOOR));
  });

  it('Close all closes it', async () => {
    const view = await opened();
    await view.click('.dock__closeall');
    await tick();
    expect(view.find('[data-task-panel]')).toBeNull();
    expect(view.host.querySelector(TAB)).toBeNull();
  });

  it("the task panel draws no close of its own in the dock: the dock's X is its one close", async () => {
    const view = await opened();
    expect(view.host.querySelector(`${TASK} [data-panel-head="close"]`)).toBeNull();
    expect(view.host.querySelectorAll(`${TASK} [data-act="close"]`)).toHaveLength(1);
  });

  it('Escape closes the panel opened last, one per press: Clients, then the task', async () => {
    const view = await opened(1700);
    (view.find('.dock__tab[data-panel="clients"]') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, shiftKey: true }),
    );
    await tick();
    expect(view.find('.dpanel[data-panel-id="clients"]')).not.toBeNull();
    escape();
    await tick();
    expect(view.find('.dpanel[data-panel-id="clients"]')).toBeNull();
    expect(view.host.querySelector(TASK)).not.toBeNull();
    escape();
    await tick();
    expect(view.find('[data-task-panel]')).toBeNull();
  });
});

describe('MP-3-1 the Task panel sits in the dock like any other panel', () => {
  it('on a phone one panel draws: the one opened last', async () => {
    const view = await app(390);
    await view.click('.dock__tab[data-panel="clients"]');
    await tick();
    await view.click(DOOR);
    await tick();
    expect(
      [...view.host.querySelectorAll<HTMLElement>('.dpanel')].map(
        (each) => each.dataset['panelId'],
      ),
    ).toEqual(['task']);
  });

  it('seated, the group track counts the Task panel', async () => {
    const view = await app(1700);
    const track = (): number =>
      Number(
        (view.find('[data-dock]') as HTMLElement).style
          .getPropertyValue('--dock-w')
          .replace('px', ''),
      );
    const before = track();
    await view.click(DOOR);
    await tick();
    expect((view.find('[data-dock]') as HTMLElement).dataset['dock']).toBe('seated');
    expect(track()).toBeGreaterThanOrEqual(before + 380);
  });

  it('the new-task draft takes the same Task panel', async () => {
    const view = await opened();
    await view.click('[data-panel-head="new"]');
    await tick();
    expect(view.find(`${TASK} [data-draft-panel]`)).not.toBeNull();
    expect(view.find('[data-task-panel]')).toBeNull();
    expect(view.find(`${TAB}[aria-expanded="true"]`)).not.toBeNull();
  });

  it('a link inside the task panel is its own, never a walk of the dock', async () => {
    const went: string[] = [];
    const view = await opened(1100, went);
    await view.click(`${TASK} [data-panel-head="page"]`);
    await tick();
    expect(went).toContain(`/task/${KEY}`);
  });
});

describe('MP-4-13 the new-task draft in the dock', () => {
  it("the draft draws no close of its own in the dock: the dock's X is its one close", async () => {
    const view = await opened();
    await view.click('[data-panel-head="new"]');
    await tick();
    expect(view.host.querySelector(`${TASK} [data-draft="close"]`)).toBeNull();
    expect(view.host.querySelectorAll(`${TASK} [data-act="close"]`)).toHaveLength(1);
  });

  it("the dock's X keeps the draft: reopened, it holds what was typed", async () => {
    const view = await opened();
    await view.click('[data-panel-head="new"]');
    await tick();
    await typeInto(view, '#panel-draft-name', 'New brief');
    await view.click(`${TASK} [data-act="close"]`);
    await tick();
    expect(view.find(`${TASK} [data-draft-panel]`)).toBeNull();
    await view.click(DOOR);
    await tick();
    await view.click('[data-panel-head="new"]');
    await tick();
    expect((view.find('#panel-draft-name') as HTMLInputElement | null)?.value).toBe('New brief');
  });
});
