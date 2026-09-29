// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-3-4: the gesture law for every open. The tab's own rule, and every other
// door into the dock (a row, a route, a badge, the ask seam, a task icon),
// which declares its target with `data-dock-open` (and `data-ask` for the
// assistant) and obeys the same law: plain solos, shift stacks, and a target
// already open is left open while its view moves.

import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { App } from '../../apps/web/src/App.tsx';
import type { PanelRegistry } from '../../apps/web/src/panels.ts';
import { SessionStore, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';

const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };
const pending = (() => new Promise<Response>(() => undefined)) as typeof globalThis.fetch;

const REGISTRY: PanelRegistry = {
  ai: { label: 'Client intelligence', ariaLabel: 'Client intelligence', route: 'agency:settings' },
  todos: { label: 'Projects', ariaLabel: 'Projects', route: 'agency:projects-board' },
  settings: { label: 'Settings', ariaLabel: 'Business settings', route: 'agency:settings' },
};

function memory(): StorageLike {
  const held = new Map([['ops-astro.session', JSON.stringify(SESSION)]]);
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

const live: Mounted[] = [];
afterEach(async () => {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
});

async function at(path = '/projects/'): Promise<Mounted> {
  const storage = memory();
  const page = await mount(
    <App
      path={path}
      navigate={() => undefined}
      sessions={new SessionStore(storage)}
      gotrueUrl="http://gotrue.test"
      apiOrigin=""
      fetch={pending}
      storage={storage as Storage}
      panels={REGISTRY}
    />,
  );
  live.push(page);
  return page;
}

async function clickOn(target: Element | null, shiftKey = false): Promise<void> {
  if (target === null) throw new Error('no target');
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey }));
  });
}

const tab = (page: Mounted, id: string): Element | null =>
  page.find(`.dock__tab[data-panel="${id}"]`);
const openIds = (page: Mounted): (string | null)[] =>
  page.all('.dpanel').map((each) => each.getAttribute('data-panel-id'));
const doorOf = (page: Mounted, id: string): string | null =>
  page.find(`[data-panel-id="${id}"] [data-act="door"]`)?.getAttribute('href') ?? null;

/** A door into the dock drawn on the page, as a row or badge would be. */
function door(page: Mounted, attributes: Readonly<Record<string, string>>): HTMLElement {
  const button = document.createElement('button');
  for (const [name, value] of Object.entries(attributes)) button.setAttribute(name, value);
  (page.find('.content') as HTMLElement).append(button);
  return button;
}

describe('MP-3-4 plain click replaces, on the only open tab closes', () => {
  it('replaces whatever is open, and closes the only open panel', async () => {
    const page = await at();
    await clickOn(tab(page, 'todos'));
    await clickOn(tab(page, 'settings'), true);
    await clickOn(tab(page, 'ai'));
    expect(openIds(page)).toEqual(['ai']);
    await clickOn(tab(page, 'ai'));
    expect(openIds(page)).toEqual([]);
  });
});

describe('MP-3-4 shift toggles beside', () => {
  it('adds a panel beside the rest, and takes just that one away again', async () => {
    const page = await at();
    await clickOn(tab(page, 'settings'));
    await clickOn(tab(page, 'todos'), true);
    await clickOn(tab(page, 'ai'), true);
    expect(openIds(page)).toEqual(['ai', 'todos', 'settings']);
    await clickOn(tab(page, 'todos'), true);
    expect(openIds(page)).toEqual(['ai', 'settings']);
  });
});

describe('MP-3-4 every programmatic open', () => {
  it('solos its target on a plain click', async () => {
    const page = await at();
    await clickOn(tab(page, 'settings'));
    await clickOn(door(page, { 'data-dock-open': 'todos', 'data-dock-place': '/task/T-1' }));
    expect(openIds(page)).toEqual(['todos']);
    expect(doorOf(page, 'todos')).toBe('/task/T-1');
  });

  it('stacks its target on shift', async () => {
    const page = await at();
    await clickOn(tab(page, 'settings'));
    await clickOn(door(page, { 'data-dock-open': 'todos' }), true);
    expect(openIds(page)).toEqual(['todos', 'settings']);
  });

  it('closes nothing when its target is already open: the view moves inside it', async () => {
    const page = await at();
    await clickOn(tab(page, 'settings'));
    await clickOn(tab(page, 'todos'), true);
    await clickOn(door(page, { 'data-dock-open': 'todos', 'data-dock-place': '/task/T-2' }));
    expect(openIds(page)).toEqual(['todos', 'settings']);
    expect(doorOf(page, 'todos')).toBe('/task/T-2');
  });

  it('works from inside another panel, and from a child of the door', async () => {
    const page = await at();
    await clickOn(tab(page, 'settings'));
    const inner = document.createElement('span');
    const button = door(page, { 'data-dock-open': 'todos' });
    button.append(inner);
    (page.find('[data-panel-id="settings"] .dpanel__body') as HTMLElement).append(button);
    await clickOn(inner, true);
    expect(openIds(page)).toEqual(['todos', 'settings']);
  });

  it('refuses an unknown or unregistered target and a place this application does not own', async () => {
    const page = await at();
    await clickOn(tab(page, 'settings'));
    for (const target of ['bell', 'constructor', 'notes', '']) {
      // eslint-disable-next-line no-await-in-loop -- each click meets the state the last left
      await clickOn(door(page, { 'data-dock-open': target }));
    }
    expect(openIds(page)).toEqual(['settings']);
    for (const place of ['//evil.test/', 'https://evil.test/', 'javascript:alert(1)', '/\\evil']) {
      // eslint-disable-next-line no-await-in-loop -- each click meets the state the last left
      await clickOn(door(page, { 'data-dock-open': 'todos', 'data-dock-place': place }), true);
      expect(doorOf(page, 'todos')).toBe('/projects/');
    }
  });

  it('leaves a click another handler already took', async () => {
    const page = await at();
    const button = door(page, { 'data-dock-open': 'todos' });
    button.addEventListener('click', (event) => {
      event.preventDefault();
    });
    await clickOn(button);
    expect(openIds(page)).toEqual([]);
  });
});

describe('MP-3-4 the ask seam', () => {
  it('replaces what is open on a plain click, and stacks on shift (the mockup stacked, D-2)', async () => {
    const page = await at();
    await clickOn(tab(page, 'todos'));
    await clickOn(door(page, { 'data-ask': 'What changed this week?' }));
    expect(openIds(page)).toEqual(['ai']);
    await clickOn(tab(page, 'todos'), true);
    await clickOn(tab(page, 'ai'));
    await clickOn(tab(page, 'todos'));
    await clickOn(door(page, { 'data-ask': '' }), true);
    expect(openIds(page)).toEqual(['ai', 'todos']);
  });
});
