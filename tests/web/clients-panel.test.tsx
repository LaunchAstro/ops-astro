// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// The dock's Clients panel (DOCK.md section 2, SL06 p-clients, BUILDABLE-NOW
// "The Clients panel"): the client book as a list. Client records (MP-10-1)
// are not built, so the book is made up behind the read's shape and carries the
// design system's mock mark. The count counts the book (D-6), a search that
// finds nothing says so (D-6), and a row's door obeys the dock's gesture law
// (MP-3-4, the pattern of dock-gesture-law.test.tsx).

import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from '../../apps/web/src/App.tsx';
import type { PanelRegistry } from '../../apps/web/src/panels.ts';
import { SessionStore, type StorageLike } from '../../apps/web/src/session/token.ts';
import { MADE_UP_BOOK, type ClientBook } from '../../apps/web/src/data/clients-book.ts';
import { ClientsScreen } from '../../apps/web/src/screens/Clients.tsx';
import { mount, type Mounted } from '../surfaces/mount.tsx';

const live: Mounted[] = [];
afterEach(async () => {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
});

async function book(given?: ClientBook): Promise<Mounted> {
  const page = await mount(<ClientsScreen book={given} />);
  live.push(page);
  return page;
}

const names = (page: Mounted): string[] =>
  page.all('.clbook__row .clbook__name').map((each) => each.textContent ?? '');
const count = (page: Mounted): string => page.find('.clbook__count')?.textContent ?? '';

const SMALL: ClientBook = {
  clients: [
    { slug: 'zeta', name: 'Zeta Yoga', industry: 'Fitness', open: 3, waiting: 0 },
    { slug: 'acme', name: 'Acme Dental', industry: 'Dental', open: 4, waiting: 0 },
  ],
};

describe('Clients panel registration', () => {
  // A panel's registration names the route that draws it at an address of its
  // own (panels.ts, R34), and no route draws the book yet: `agency:clients` at
  // `/clients/` waits on the lead's ruling, since this piece adds no route.
  it.todo('registers as the clients tab, drawn between team and todos in PANEL_RANK');
});

describe('Clients panel made-up book', () => {
  it('draws every client in the book A to Z inside the mock mark, and says the book is made up', async () => {
    const page = await book();
    expect(names(page)).toEqual(MADE_UP_BOOK.clients.map((each) => each.name).toSorted());
    const region = page.find('.is-mock');
    expect(region?.querySelector('.mocktag')?.textContent).toBe('Mock');
    expect(region?.querySelectorAll('.clbook__row')).toHaveLength(MADE_UP_BOOK.clients.length);
    expect(page.find('.clbook__note')?.textContent).toMatch(/made up/iu);
  });

  it('draws each row with its initials, name and industry', async () => {
    const page = await book(SMALL);
    const first = page.find('.clbook__row');
    expect(first?.querySelector('.clbook__tile')?.textContent).toBe('AD');
    expect(first?.querySelector('.clbook__industry')?.textContent).toBe('Dental');
  });
});

describe('Clients panel count counts the book', () => {
  it('counts the rows the book holds, their open work and what waits on us', async () => {
    const page = await book();
    const all = MADE_UP_BOOK.clients;
    const open = all.reduce((sum, each) => sum + each.open, 0);
    const waiting = all.reduce((sum, each) => sum + each.waiting, 0);
    expect(count(page)).toBe(
      `${all.length} of ${all.length} clients · ${open} open · ${waiting} waiting on us`,
    );
  });

  it('leaves the waiting clause out when nothing waits on us', async () => {
    const page = await book(SMALL);
    expect(count(page)).toBe('2 of 2 clients · 7 open');
  });
});

describe('Clients panel search narrows the book', () => {
  it('narrows by name or industry, whatever the case, and the count follows', async () => {
    const page = await book(SMALL);
    await page.type('.clbook input[type="search"]', 'DENTAL');
    expect(names(page)).toEqual(['Acme Dental']);
    expect(count(page)).toBe('1 of 2 clients · 4 open');
    await page.type('.clbook input[type="search"]', 'fitness');
    expect(names(page)).toEqual(['Zeta Yoga']);
  });

  it('says so in a sentence when nothing matches', async () => {
    const page = await book(SMALL);
    expect(page.find('.clbook__empty')).toBeNull();
    await page.type('.clbook input[type="search"]', 'plumbing');
    expect(names(page)).toEqual([]);
    expect(page.find('.clbook__empty')?.textContent).toBe(
      'No client in the book matches “plumbing”.',
    );
    expect(count(page)).toBe('0 of 2 clients · 0 open');
  });
});

// The gesture law, as dock-gesture-law.test.tsx drives it: the panel's own
// markup placed inside an open panel, and its row door pressed.
const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };
const pending = (() => new Promise<Response>(() => {})) as typeof globalThis.fetch;
const SETTINGS = {
  label: 'Settings',
  ariaLabel: 'Business settings',
  route: 'agency:settings',
} as const;
const WITH_PROJECTS: PanelRegistry = {
  todos: { label: 'Projects', ariaLabel: 'Projects', route: 'agency:projects-board' },
  settings: SETTINGS,
};
const WITHOUT_PROJECTS: PanelRegistry = { settings: SETTINGS };

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

async function app(panels: PanelRegistry, went: string[] = []): Promise<Mounted> {
  const storage = memory();
  const page = await mount(
    <App
      path="/settings"
      navigate={(path) => {
        went.push(path);
      }}
      sessions={new SessionStore(storage)}
      gotrueUrl="http://gotrue.test"
      apiOrigin=""
      fetch={pending}
      storage={storage as Storage}
      panels={panels}
    />,
  );
  live.push(page);
  return page;
}

async function press(target: Element | null, shiftKey = false): Promise<void> {
  if (target === null) throw new Error('no target');
  await act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey }));
  });
}

const openIds = (page: Mounted): (string | undefined)[] =>
  page.all('.dpanel').map((each) => (each as HTMLElement).dataset['panelId']);

/** Settings open, with the Clients panel's own markup in its body; the first row's Projects door. */
async function rowDoor(page: Mounted): Promise<Element | null> {
  await press(page.find('.dock__tab[data-panel="settings"]'));
  const body = page.find('[data-panel-id="settings"] .dpanel__body') as HTMLElement;
  body.insertAdjacentHTML('beforeend', renderToStaticMarkup(<ClientsScreen book={SMALL} />));
  return body.querySelector('.clbook__row .clbook__door');
}

describe('Clients panel row doors follow the gesture law', () => {
  it('a plain press on a row door solos the Projects panel at the board', async () => {
    const page = await app(WITH_PROJECTS);
    await press(await rowDoor(page));
    expect(openIds(page)).toEqual(['todos']);
    expect(page.find('[data-panel-id="todos"] [data-act="door"]')?.getAttribute('href')).toBe(
      '/projects/',
    );
  });

  it('a shift press stacks the Projects panel beside', async () => {
    const page = await app(WITH_PROJECTS);
    await press(await rowDoor(page), true);
    expect(openIds(page)).toEqual(['todos', 'settings']);
  });

  it('with no Projects panel registered, the door is a link the application follows', async () => {
    const went: string[] = [];
    const page = await app(WITHOUT_PROJECTS, went);
    await press(await rowDoor(page));
    expect(went.at(-1)).toBe('/projects/');
  });
});
