// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A Cmd, Ctrl or Alt click on a link into the dock (a row's `data-dock-open`
// door, as the Clients list draws) asks the browser for a new tab, a new
// window or a download, so the dock leaves it: the click is not cancelled and
// no panel opens. Shift keeps its own meaning on a door and stacks the panel.
// The panel head's page door leaves every modified click to the browser too.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import type { PanelRegistry } from '../../apps/web/src/panels.ts';
import { SessionStore, type StorageLike } from '../../apps/web/src/session/token.ts';
import { Dock, type DockPanel } from '../../packages/ui/src/surfaces/Dock.tsx';
import { dockOf } from './dock-props.ts';
import { mount, type Mounted } from './mount.tsx';

const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };
const REGISTRY: PanelRegistry = {
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

async function app(): Promise<Mounted> {
  const storage = memory();
  const page = await mount(
    <App
      path="/projects/"
      navigate={() => {}}
      sessions={new SessionStore(storage)}
      gotrueUrl="http://gotrue.test"
      apiOrigin=""
      fetch={(() => new Promise<Response>(() => {})) as typeof globalThis.fetch}
      storage={storage as Storage}
      panels={REGISTRY}
    />,
  );
  live.push(page);
  return page;
}

type Modifier = 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey';

/** A primary click with `modifier` held: whether something cancelled it. */
async function clickWith(target: Element | null, modifier?: Modifier): Promise<boolean> {
  if (target === null) throw new Error('no target');
  const click = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...(modifier === undefined ? {} : { [modifier]: true }),
  });
  // Read after React's handlers, then stop jsdom from trying to load the link.
  let cancelled = false;
  const hear = (event: Event): void => {
    cancelled = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener('click', hear);
  try {
    await act(() => {
      target.dispatchEvent(click);
    });
  } finally {
    document.removeEventListener('click', hear);
  }
  return cancelled;
}

const openIds = (page: Mounted): (string | undefined)[] =>
  page.all('.dpanel').map((each) => (each as HTMLElement).dataset['panelId']);

/** A link into the dock, as a Clients row draws its Projects door. */
function rowDoor(page: Mounted): HTMLAnchorElement {
  const link = document.createElement('a');
  link.setAttribute('href', '/projects/?client=c-1');
  link.dataset['dockOpen'] = 'todos';
  link.dataset['dockPlace'] = '/projects/?client=c-1';
  (page.find('.content') as HTMLElement).append(link);
  return link;
}

describe('a door into the dock', () => {
  it('leaves a Cmd, Ctrl or Alt click to the browser and opens nothing', async () => {
    const page = await app();
    await clickWith(page.find('.dock__tab[data-panel="settings"]'));
    const door = rowDoor(page);
    const heard: Record<string, { cancelled: boolean; open: (string | undefined)[] }> = {};
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey'] as const) {
      // eslint-disable-next-line no-await-in-loop -- each click meets the dock the last left
      const cancelled = await clickWith(door, modifier);
      heard[modifier] = { cancelled, open: openIds(page) };
    }
    const untouched = { cancelled: false, open: ['settings'] };
    expect(heard).toEqual({ metaKey: untouched, ctrlKey: untouched, altKey: untouched });
  });

  it('still stacks its panel beside the rest on a Shift click', async () => {
    const page = await app();
    await clickWith(page.find('.dock__tab[data-panel="settings"]'));
    expect(await clickWith(rowDoor(page), 'shiftKey')).toBe(true);
    expect(openIds(page)).toEqual(['todos', 'settings']);
  });
});

describe("a dock panel head's page door", () => {
  const panel: DockPanel = {
    id: 'todos',
    label: 'Projects',
    ariaLabel: 'Projects',
    door: '/todos',
    canBack: false,
    canForward: false,
    body: null,
  };

  it('leaves a Cmd, Ctrl, Shift or Alt click to the browser, and follows a plain one', async () => {
    const visited: string[] = [];
    const page = await mount(
      <Dock {...dockOf([])} panels={[panel]} onDoor={(href) => visited.push(href)} />,
    );
    live.push(page);
    const door = page.find('[data-act="door"]');
    const cancelled: Record<string, boolean> = {};
    for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one click at a time
      cancelled[modifier] = await clickWith(door, modifier);
    }
    expect({ cancelled, visited }).toEqual({
      cancelled: { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
      visited: [],
    });
    expect(await clickWith(door)).toBe(true);
    expect(visited).toEqual(['/todos']);
  });
});
