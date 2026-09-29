// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-3-1c to e, through the application: the open set outlives navigation and
// a reload, Escape takes the last opened panel and never a field's Escape, the
// X reaches the panel's tenant, and the door carries the view's own address.
// Every read stays in flight: only the dock is under test.

import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { App } from '../../apps/web/src/App.tsx';
import type { PanelRegistry } from '../../apps/web/src/panels.ts';
import { SessionStore, dockKey, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';

const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };

function memory(): StorageLike & { readonly held: Map<string, string> } {
  const held = new Map([['ops-astro.session', JSON.stringify(SESSION)]]);
  return {
    held,
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  };
}

const pending = (() => new Promise<Response>(() => undefined)) as typeof globalThis.fetch;

const closedFor: string[] = [];
const REGISTRY: PanelRegistry = {
  todos: {
    label: 'Projects',
    ariaLabel: 'Projects',
    route: 'agency:projects-board',
  },
  settings: {
    label: 'Settings',
    ariaLabel: 'Business settings',
    route: 'agency:settings',
    onClose: () => closedFor.push('settings'),
  },
};

const live: Mounted[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map(async (page) => await page.unmount()));
  closedFor.length = 0;
});

function app(path: string, storage: StorageLike, went: string[] = []) {
  return (
    <App
      path={path}
      navigate={(next) => went.push(next)}
      sessions={new SessionStore(storage)}
      gotrueUrl="http://gotrue.test"
      apiOrigin=""
      fetch={pending}
      storage={storage as Storage}
      panels={REGISTRY}
    />
  );
}

async function at(path: string, storage: StorageLike, went: string[] = []): Promise<Mounted> {
  const page = await mount(app(path, storage, went));
  live.push(page);
  return page;
}

const tabOf = (page: Mounted, id: string): HTMLElement =>
  page.find(`.dock__tab[data-panel="${id}"]`) as HTMLElement;

async function press(page: Mounted, id: string, shiftKey = false): Promise<void> {
  await act(async () => {
    tabOf(page, id).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey }));
  });
}

async function escapeOn(target: EventTarget, init: KeyboardEventInit = {}): Promise<boolean> {
  let dispatched = true;
  await act(async () => {
    dispatched = target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }),
    );
  });
  return dispatched;
}

const openIds = (page: Mounted): (string | null)[] =>
  page.all('.dpanel').map((each) => each.getAttribute('data-panel-id'));

describe('MP-3-1 gesture opens', () => {
  it('a plain click shows one panel and a shift-click adds a second beside it, in rank order', async () => {
    const page = await at('/projects/', memory());
    await press(page, 'settings');
    expect(openIds(page)).toEqual(['settings']);
    await press(page, 'todos', true);
    expect(openIds(page)).toEqual(['todos', 'settings']);
    expect(tabOf(page, 'todos').getAttribute('aria-expanded')).toBe('true');
    expect(tabOf(page, 'settings').getAttribute('aria-label')).toBe('Close Settings');
  });
});

describe('R2-SURFACE-42: the settings dock tab does what it announces', () => {
  it('"Open Settings" opens its panel where you are and "Close Settings" closes it', async () => {
    const went: string[] = [];
    const page = await at('/projects/', memory(), went);
    expect(tabOf(page, 'settings').getAttribute('aria-label')).toBe('Open Settings');
    await press(page, 'settings');
    expect(openIds(page)).toEqual(['settings']);
    expect(tabOf(page, 'settings').getAttribute('aria-label')).toBe('Close Settings');
    await press(page, 'settings');
    expect(openIds(page)).toEqual([]);
    expect(went).toEqual([]);
  });
});

describe('MP-3-1 open set survives navigation', () => {
  it('keeps both panels open when the page changes, and after a reload', async () => {
    const storage = memory();
    const page = await at('/projects/', storage);
    await press(page, 'settings');
    await press(page, 'todos', true);
    await page.render(app('/settings', storage));
    expect(openIds(page)).toEqual(['todos', 'settings']);

    const reloaded = await at('/task/T-1', storage);
    expect(openIds(reloaded)).toEqual(['todos', 'settings']);
  });

  it('forgets the open set at sign-out', async () => {
    const storage = memory();
    const page = await at('/projects/', storage);
    await press(page, 'settings');
    expect(storage.held.has(dockKey('alpha'))).toBe(true);
    await page.click('.topbar__who .btn');
    expect(storage.held.has(dockKey('alpha'))).toBe(false);
  });
});

describe('MP-3-1 escape order', () => {
  it('closes the last opened panel, one per press', async () => {
    const page = await at('/projects/', memory());
    await press(page, 'todos');
    await press(page, 'settings', true);
    await escapeOn(document);
    expect(openIds(page)).toEqual(['todos']);
    await escapeOn(document);
    expect(openIds(page)).toEqual([]);
  });

  it('closes nothing when a field, menu or editor inside a panel handled it', async () => {
    const page = await at('/projects/', memory());
    await press(page, 'settings');
    const body = page.find('.dpanel__body') as HTMLElement;
    const hosts = [
      Object.assign(document.createElement('input'), { type: 'text' }),
      document.createElement('textarea'),
      document.createElement('select'),
      Object.assign(document.createElement('div'), { contentEditable: 'true' }),
      Object.assign(document.createElement('div'), { role: 'combobox' }),
      Object.assign(document.createElement('ul'), { role: 'menu' }),
      Object.assign(document.createElement('div'), { role: 'listbox' }),
      Object.assign(document.createElement('div'), { role: 'textbox' }),
    ];
    for (const host of hosts) {
      const inner = document.createElement('span');
      host.append(inner);
      body.append(host);
      // One at a time: each press must meet the panel still open.
      // eslint-disable-next-line no-await-in-loop
      await escapeOn(inner);
      // eslint-disable-next-line no-await-in-loop
      await escapeOn(host);
    }
    expect(openIds(page)).toEqual(['settings']);
  });

  it('closes nothing when something else already took the key', async () => {
    const page = await at('/projects/', memory());
    await press(page, 'settings');
    const taker = document.createElement('button');
    (page.find('.dpanel__body') as HTMLElement).append(taker);
    taker.addEventListener('keydown', (event) => {
      event.preventDefault();
    });
    await escapeOn(taker);
    expect(openIds(page)).toEqual(['settings']);
  });

  it('ignores every other key and a repeat of nothing open', async () => {
    const page = await at('/projects/', memory());
    await press(page, 'settings');
    await escapeOn(document, { key: 'Esc' });
    await escapeOn(document, { key: 'Enter' });
    expect(openIds(page)).toEqual(['settings']);
  });
});

describe('MP-3-1 x closes own', () => {
  it('the X reaches only its own tenant and drops its stored place', async () => {
    const storage = memory();
    storage.setItem(
      dockKey('alpha'),
      JSON.stringify({
        who: SESSION.email,
        open: ['todos', 'settings'],
        places: { todos: '/task/T-1', settings: '/settings' },
      }),
    );
    const page = await at('/projects/', storage);
    await page.click('[data-panel-id="settings"] .dpanel__x');
    expect(openIds(page)).toEqual(['todos']);
    expect(closedFor).toEqual(['settings']);
    expect(JSON.parse(storage.getItem(dockKey('alpha')) ?? 'null')).toEqual({
      who: SESSION.email,
      open: ['todos'],
      places: { todos: '/task/T-1' },
    });
  });

  it('Close all and Escape reach the tenant too', async () => {
    const page = await at('/projects/', memory());
    await press(page, 'settings');
    await escapeOn(document);
    await press(page, 'settings');
    await press(page, 'todos', true);
    await page.click('.dock__closeall');
    expect(openIds(page)).toEqual([]);
    expect(closedFor).toEqual(['settings', 'settings']);
  });
});

const doorOf = (page: Mounted): string | null =>
  page.find('[data-panel-id="todos"] [data-act="door"]')?.getAttribute('href') ?? null;

describe('MP-3-1 door falls back', () => {
  const stored = (places: Record<string, string>): StorageLike => {
    const storage = memory();
    storage.setItem(
      dockKey('alpha'),
      JSON.stringify({ who: SESSION.email, open: ['todos'], places }),
    );
    return storage;
  };
  it('carries the view it is on: a walked task, a scoped list', async () => {
    expect(doorOf(await at('/settings', stored({ todos: '/task/T-1' })))).toBe('/task/T-1');
    expect(doorOf(await at('/settings', stored({ todos: '/projects/?client=c-1' })))).toBe(
      '/projects/?client=c-1',
    );
  });

  it('falls back to its board when the view has no address of its own', async () => {
    expect(doorOf(await at('/settings', stored({})))).toBe('/projects/');
    expect(doorOf(await at('/settings', stored({ todos: '/nowhere' })))).toBe('/projects/');
    expect(doorOf(await at('/settings', stored({ todos: '/sign-in' })))).toBe('/projects/');
  });

  it('a link inside the panel walks the panel, not the page, and the door follows', async () => {
    const went: string[] = [];
    const page = await at('/settings', stored({}), went);
    const link = Object.assign(document.createElement('a'), { href: '/task/T-9' });
    (page.find('[data-panel-id="todos"] .dpanel__body') as HTMLElement).append(link);
    await act(async () => {
      link.click();
    });
    expect(went).toEqual([]);
    expect(doorOf(page)).toBe('/task/T-9');
    await page.click('[data-panel-id="todos"] [data-act="door"]');
    expect(went).toEqual(['/task/T-9']);
  });
});

describe('MP-3-1 data-backed tabs', () => {
  it('draws no dock signed out or on the client face', async () => {
    const signedOut = memory();
    signedOut.removeItem('ops-astro.session');
    expect((await at('/sign-in', signedOut)).all('.dock__tab')).toHaveLength(0);
  });
});
