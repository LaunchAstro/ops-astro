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
import type { RailPreference } from '../../apps/web/src/shell/use-rail.ts';
import { app, at, drawn, grip, key, pointer, railWidth, shell, unmountAll } from './rail-app.tsx';

const SHEET = readFileSync('packages/ui/src/styles/3-shell.css', 'utf8');

afterEach(unmountAll);

describe('MP-2-3 collapse and back', () => {
  it('folds the rail to a 56px strip and opens it again at the width it had', async () => {
    const saved: RailPreference[] = [];
    const page = await at({ rail: { collapsed: false, width: 300 }, saved });
    const fold = page.find('.railfold') as HTMLButtonElement;
    expect(fold.getAttribute('aria-label')).toBe('Collapse the menu');
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    await page.click('.railfold');
    expect(shell(page).dataset['rail']).toBe('collapsed');
    expect(railWidth(page)).toBe('56px');
    expect(fold.getAttribute('aria-label')).toBe('Expand the menu');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    await page.click('.railfold');
    expect(shell(page).dataset['rail']).toBe('expanded');
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
    const page = await drawn(
      <Shell
        face="client"
        build={null}
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
    await act(() => {
      grip(page).dispatchEvent(pointer('pointerdown', 224));
      grip(page).dispatchEvent(pointer('pointermove', 900));
    });
    expect(railWidth(page)).toBe('400px');
    await act(() => {
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
    expect(shell(page).dataset['rail']).toBe('expanded');
    expect(railWidth(page)).toBe('224px');
  });
});

describe('MP-2-3 live, saved on release', () => {
  it('moves with every pointer move and is kept once, when let go (DS-SIDE-D11 not copied)', async () => {
    const saved: RailPreference[] = [];
    const page = await at({ saved });
    await act(() => {
      grip(page).dispatchEvent(pointer('pointerdown', 224));
      grip(page).dispatchEvent(pointer('pointermove', 250));
    });
    expect(railWidth(page)).toBe('250px');
    // The drag suspends the grid's transition, so the rail does not trail the
    // cursor (DS-SIDE-D4 not copied).
    expect(Object.hasOwn(shell(page).dataset, 'railDragging')).toBe(true);
    await act(() => {
      grip(page).dispatchEvent(pointer('pointermove', 310));
    });
    expect(railWidth(page)).toBe('310px');
    expect(saved).toEqual([]);
    await act(() => {
      grip(page).dispatchEvent(pointer('pointerup', 320));
    });
    expect(railWidth(page)).toBe('320px');
    expect(Object.hasOwn(shell(page).dataset, 'railDragging')).toBe(false);
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
