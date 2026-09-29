// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-2-3: the rail folds to a 56px strip of icons, each with its section's
// name, and back; its edge drags it from 170 to 400, live, kept on release,
// by pointer or keys; what the person left is drawn on the first render, so
// nothing jumps; and the dock's geometry measures the rail as drawn.
//
// The preference store is MP-2-11's. Until it is on main the application is
// handed the person's rail before its first render and tells a saver when it
// changes; the store's legs are named it.todo below.

import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { Shell } from '../../packages/ui/src/surfaces/Shell.tsx';
import { App } from '../../apps/web/src/App.tsx';
import type { PanelRegistry } from '../../apps/web/src/panels.ts';
import type { RailPreference } from '../../apps/web/src/shell/use-rail.ts';
import { SessionStore, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';

const SHEET = readFileSync('packages/ui/src/styles/3-shell.css', 'utf8');

const live: Mounted[] = [];
afterEach(async () => {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
});

const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@example.test' };
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

function app(input: {
  readonly width?: number;
  readonly rail?: RailPreference;
  readonly saved?: RailPreference[];
}) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: input.width ?? 1480 });
  const storage = memory();
  return (
    <App
      path="/projects/"
      navigate={() => undefined}
      sessions={new SessionStore(storage)}
      gotrueUrl="http://gotrue.test"
      apiOrigin=""
      fetch={(() => new Promise<Response>(() => undefined)) as typeof globalThis.fetch}
      storage={storage as Storage}
      panels={REGISTRY}
      {...(input.rail === undefined ? {} : { railPreference: input.rail })}
      saveRailPreference={(preference) => input.saved?.push(preference)}
    />
  );
}

async function at(input: Parameters<typeof app>[0]): Promise<Mounted> {
  const page = await mount(app(input));
  live.push(page);
  return page;
}

const shell = (page: Mounted): HTMLElement => page.find('.shell') as HTMLElement;
const railWidth = (page: Mounted): string => shell(page).style.getPropertyValue('--rail-w');
const grip = (page: Mounted): HTMLElement => {
  const found = page.find('.railgrip') as HTMLElement;
  found.setPointerCapture = () => undefined;
  return found;
};
const pointer = (type: string, clientX: number): Event =>
  Object.assign(new MouseEvent(type, { bubbles: true, clientX }), { pointerId: 1 });
const key = async (target: HTMLElement, name: string, shiftKey = false): Promise<void> => {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true }));
  });
};

describe('MP-2-3 collapse and back', () => {
  it('folds the rail to a 56px strip and opens it again at the width it had', async () => {
    const saved: RailPreference[] = [];
    const page = await at({ rail: { collapsed: false, width: 300 }, saved });
    const fold = page.find('.railfold') as HTMLButtonElement;
    expect(fold.getAttribute('aria-label')).toBe('Collapse the menu');
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    await page.click('.railfold');
    expect(shell(page).getAttribute('data-rail')).toBe('collapsed');
    expect(railWidth(page)).toBe('56px');
    expect(fold.getAttribute('aria-label')).toBe('Expand the menu');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    await page.click('.railfold');
    expect(shell(page).getAttribute('data-rail')).toBe('expanded');
    expect(railWidth(page)).toBe('300px');
    expect(saved).toEqual([
      { collapsed: true, width: 300 },
      { collapsed: false, width: 300 },
    ]);
  });

  it('puts the fold button first in the rail, where it is drawn (DS-SIDE-D10 not copied)', async () => {
    const page = await at({});
    const focusable = page.all('.rail button, .rail a, .rail [tabindex="0"]');
    expect(focusable[0]?.classList.contains('railfold')).toBe(true);
  });
});

describe('MP-2-3 56px strip: an icon and a title on every section', () => {
  it('draws a glyph and the name on hover for every item, the way back included', async () => {
    const page = await mount(
      <Shell
        face="client"
        rail={[
          { id: 'clients:back', label: 'Back to Clients', href: '/clients/' },
          { id: 'clients:overview', label: 'Overview', href: '/clients/a/' },
          { id: 'clients:tasks', label: 'Tasks', href: '/clients/a/tasks/' },
        ]}
        here="/clients/a/"
        title="Overview"
        dock={null}
        railCollapsed
        railWidth={224}
      >
        {null}
      </Shell>,
    );
    live.push(page);
    const items = page.all('.rail__item');
    expect(items).toHaveLength(3);
    for (const item of items) {
      const label = item.querySelector('.rail__label')?.textContent ?? '';
      expect(label).not.toBe('');
      // The name on hover, and still the item's accessible name.
      expect(item.getAttribute('title')).toBe(label);
      const glyph = item.querySelector('.rail__glyph');
      expect(glyph?.getAttribute('aria-hidden')).toBe('true');
      expect(glyph?.textContent).toBe(label.slice(0, 1));
    }
    // The label is hidden visually in the strip, not removed.
    expect(SHEET).toMatch(
      /\.shell\[data-rail='collapsed'\] \.rail__label\s*\{[^}]*clip-path: inset\(50%\)/u,
    );
  });

  it('carries no hover title while the names are showing', async () => {
    const page = await at({ rail: { collapsed: false, width: 224 } });
    expect(page.all('.rail__item').every((item) => !item.hasAttribute('title'))).toBe(true);
  });
});

describe('MP-2-3 drag clamped 170 to 400', () => {
  it('holds the width at 400 dragged past it and at 170 dragged under it', async () => {
    const saved: RailPreference[] = [];
    const page = await at({ saved });
    await act(async () => {
      grip(page).dispatchEvent(pointer('pointerdown', 224));
      grip(page).dispatchEvent(pointer('pointermove', 900));
    });
    expect(railWidth(page)).toBe('400px');
    await act(async () => {
      grip(page).dispatchEvent(pointer('pointermove', 20));
      grip(page).dispatchEvent(pointer('pointerup', 20));
    });
    expect(railWidth(page)).toBe('170px');
    expect(saved).toEqual([{ collapsed: false, width: 170 }]);
  });

  it('holds a stored width outside the range, and refuses one that is not a number', async () => {
    expect(railWidth(await at({ rail: { collapsed: false, width: 9000 } }))).toBe('400px');
    expect(railWidth(await at({ rail: { collapsed: false, width: -5 } }))).toBe('170px');
    expect(railWidth(await at({ rail: { collapsed: false, width: Number.NaN } }))).toBe('224px');
    const odd = { collapsed: 'yes', width: '300' } as unknown as RailPreference;
    const page = await at({ rail: odd });
    expect(shell(page).getAttribute('data-rail')).toBe('expanded');
    expect(railWidth(page)).toBe('224px');
  });
});

describe('MP-2-3 live, saved on release', () => {
  it('moves with every pointer move and is kept once, when let go (DS-SIDE-D11 not copied)', async () => {
    const saved: RailPreference[] = [];
    const page = await at({ saved });
    await act(async () => {
      grip(page).dispatchEvent(pointer('pointerdown', 224));
      grip(page).dispatchEvent(pointer('pointermove', 250));
    });
    expect(railWidth(page)).toBe('250px');
    // The drag suspends the grid's transition, so the rail does not trail the
    // cursor (DS-SIDE-D4 not copied).
    expect(shell(page).hasAttribute('data-rail-dragging')).toBe(true);
    await act(async () => {
      grip(page).dispatchEvent(pointer('pointermove', 310));
    });
    expect(railWidth(page)).toBe('310px');
    expect(saved).toEqual([]);
    await act(async () => {
      grip(page).dispatchEvent(pointer('pointerup', 320));
    });
    expect(railWidth(page)).toBe('320px');
    expect(shell(page).hasAttribute('data-rail-dragging')).toBe(false);
    expect(saved).toEqual([{ collapsed: false, width: 320 }]);
    expect(SHEET).toMatch(/\.shell\[data-rail-dragging\][^{]*\{[^}]*transition: none/u);
  });
});

describe('MP-2-3 pointer and keyboard: resize and reset', () => {
  it('is a focusable separator: the arrows resize, shift further, Home resets', async () => {
    const saved: RailPreference[] = [];
    const page = await at({ saved });
    const edge = grip(page);
    expect(edge.getAttribute('role')).toBe('separator');
    expect(edge.getAttribute('aria-orientation')).toBe('vertical');
    expect(edge.getAttribute('aria-label')).toBe('Menu width');
    expect(edge.getAttribute('tabindex')).toBe('0');
    expect(edge.getAttribute('aria-valuenow')).toBe('224');
    expect(edge.getAttribute('aria-valuemin')).toBe('170');
    expect(edge.getAttribute('aria-valuemax')).toBe('400');
    await key(edge, 'ArrowRight');
    await key(edge, 'ArrowRight', true);
    await key(edge, 'ArrowLeft');
    expect(railWidth(page)).toBe('288px');
    await key(edge, 'Home');
    expect(railWidth(page)).toBe('224px');
    expect(saved.map((each) => each.width)).toEqual([240, 304, 288, 224]);
  });

  it('has no grip in the strip: the fold button is the way back', async () => {
    const page = await at({ rail: { collapsed: true, width: 300 } });
    expect(page.find('.railgrip')).toBeNull();
  });
});

describe('MP-2-3 replayed before paint', () => {
  it('draws the rail as the person left it on the first render, with nothing animating', () => {
    const open = renderToStaticMarkup(app({ rail: { collapsed: false, width: 320 } }));
    expect(open).toMatch(/class="shell"[^>]*data-rail="expanded"/u);
    expect(open).toMatch(/--rail-w:320px/u);
    const folded = renderToStaticMarkup(app({ rail: { collapsed: true, width: 320 } }));
    expect(folded).toMatch(/class="shell"[^>]*data-rail="collapsed"/u);
    expect(folded).toMatch(/--rail-w:56px/u);
    // The grid transitions only once the shell is ready, after its first layout.
    expect(folded).not.toMatch(/data-dock-ready/u);
    expect(SHEET).not.toMatch(/\n\.shell\s*\{[^}]*transition:/u);
  });
});

const openTodos = async (page: Mounted): Promise<void> => {
  await act(async () => {
    page
      .find('.dock__tab[data-panel="todos"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};
const mode = (page: Mounted): string | null =>
  page.find('.dock')?.getAttribute('data-mode') ?? null;

describe('MP-2-3 the dock follows the rail', () => {
  it('seats a panel beside a folded rail where the open rail leaves no room', async () => {
    // At 1500 one 550 panel needs 224 + 836 + 40 + 550 = 1650 beside an open
    // rail, and 56 + 836 + 40 + 550 = 1482 beside a folded one.
    const page = await at({ width: 1500 });
    await openTodos(page);
    expect(mode(page)).toBe('floating');
    await page.click('.railfold');
    expect(mode(page)).toBe('seated');
    expect(shell(page).style.getPropertyValue('--dock-w')).toBe('550px');
  });

  it('floats the panel when the rail is dragged wide enough to take its seat', async () => {
    // At 1700: 1700 - 224 - 876 = 600 seats 550; 1700 - 400 - 876 = 424 does not.
    const page = await at({ width: 1700 });
    await openTodos(page);
    expect(mode(page)).toBe('seated');
    await key(grip(page), 'ArrowRight', true);
    await key(grip(page), 'ArrowRight', true);
    await key(grip(page), 'ArrowRight', true);
    expect(railWidth(page)).toBe('400px');
    expect(mode(page)).toBe('floating');
  });
});

describe('MP-2-3 at 900 and below the rail is the drawer', () => {
  it('hides the fold and the grip, and the strip rules never reach the drawer', () => {
    const phone = SHEET.slice(SHEET.indexOf('/* -- The rail folds (MP-2-3)'));
    expect(phone).toMatch(
      /@media not all and \(max-width: 900px\) \{\s*\.shell\[data-rail='collapsed'\]/u,
    );
    expect(SHEET).toMatch(
      /@media \(width <= 900px\) \{\s*\.railfold,\s*\.railgrip \{\s*display: none;/u,
    );
  });
});

describe('MP-2-3 the preference store', () => {
  it.todo(
    'MP-2-3 width in one store: rail.width and rail.collapsed are keys of the one preference store (waits on MP-2-11)',
  );
  it.todo(
    'MP-2-3 own preference only: preference saved writes only the signed-in person row; a write to another person row is refused (waits on MP-2-11)',
  );
  it.todo('MP-2-3 no audit: a rail preference save and read add no audit event (waits on MP-2-11)');
  it.todo('MP-2-3 reload keeps it: fold, drag wider, reload, as left (waits on MP-2-11)');
  it.todo(
    'MP-2-3 visual match: /dashboard/ rail collapsed at 1480, 900 and 390, light and dark (waits on MP-1-7)',
  );
});
