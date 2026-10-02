// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-3-2a: the dock's geometry as one function. Every row of the mockup
// inventory's measured table (DOCK.md 1.3, driven at a 1000px-tall viewport
// with the 224px nav rail) for one, two and three panels, and the one place
// the table breaks its own law (D-5: at 1280 three panels drew below the floor
// and unequal), which here closes the lowest-ranked panel instead (R39).

import { describe, expect, it } from 'vitest';
import {
  CONTENT_FLOOR,
  PANEL_DEFAULT,
  PANEL_FLOOR,
  dockGeometry,
  type DockGeometry,
} from '../../apps/web/src/dock/geometry.ts';
import type { PanelId } from '../../apps/web/src/panels.ts';

const ONE: readonly PanelId[] = ['clients'];
const TWO: readonly PanelId[] = ['ai', 'clients'];
const THREE: readonly PanelId[] = ['ai', 'clients', 'notes'];

const at = (viewport: number, open: readonly PanelId[], width = PANEL_DEFAULT): DockGeometry =>
  dockGeometry({ viewport, navRail: 224, width, open });

const row = (geometry: DockGeometry) => ({
  mode: geometry.mode,
  each: geometry.panelWidth,
  group: geometry.groupWidth,
  content: geometry.content,
});

describe('MP-3-2 geometry table', () => {
  it('reproduces the measured rows for one panel', () => {
    expect(row(at(2400, ONE))).toEqual({ mode: 'seated', each: 550, group: 550, content: 1626 });
    expect(row(at(1700, ONE))).toEqual({ mode: 'seated', each: 550, group: 550, content: 926 });
    expect(row(at(1480, ONE))).toEqual({ mode: 'floating', each: 550, group: 550, content: 1256 });
    expect(row(at(1440, ONE))).toMatchObject({ mode: 'floating', each: 550 });
    expect(row(at(1280, ONE))).toMatchObject({ mode: 'floating', each: 550 });
  });

  it('reproduces the measured rows for two panels', () => {
    expect(row(at(2400, TWO))).toEqual({ mode: 'seated', each: 550, group: 1100, content: 1076 });
    expect(row(at(1700, TWO))).toEqual({
      mode: 'floating',
      each: 550,
      group: 1100,
      content: 1476,
    });
    expect(at(1700, TWO).groupLeft).toBe(600);
    expect(at(1480, TWO).groupLeft).toBe(380);
    expect(row(at(1440, TWO))).toMatchObject({ mode: 'floating', each: 550, group: 1100 });
    expect(row(at(1280, TWO))).toMatchObject({ mode: 'floating', each: 528, group: 1056 });
  });

  it('reproduces the measured rows for three panels', () => {
    expect(row(at(2400, THREE))).toEqual({
      mode: 'floating',
      each: 550,
      group: 1650,
      content: 2176,
    });
    expect(at(2400, THREE).groupLeft).toBe(750);
    expect(row(at(1700, THREE))).toMatchObject({ mode: 'floating', each: 492, group: 1476 });
    expect(row(at(1480, THREE))).toMatchObject({ mode: 'floating', each: 418, group: 1254 });
    expect(row(at(1440, THREE))).toMatchObject({ mode: 'floating', each: 405, group: 1215 });
  });
});

describe('MP-3-2 geometry table', () => {
  it('where three cannot fit at the floor, closes the lowest-ranked one and says so (R39)', () => {
    const narrow = at(1280, THREE);
    expect(narrow.closes).toBe('notes');
    expect(narrow.open).toEqual(['ai', 'clients']);
    expect(row(narrow)).toMatchObject({ mode: 'floating', each: 528, group: 1056 });
    expect(at(1440, THREE).closes).toBeNull();
  });

  it('draws nothing at rest and leaves the content the whole width beside the nav rail', () => {
    expect(row(at(1480, []))).toEqual({ mode: 'rest', each: 0, group: 0, content: 1256 });
  });

  it('leaves the side tier below 1280: the sheet is MP-3-3', () => {
    expect(at(1279, ONE).mode).toBe('sheet');
  });
});

describe('MP-3-2 content floor', () => {
  it('never seats a panel that would take the content column under 836', () => {
    for (let viewport = 1280; viewport <= 2600; viewport += 10) {
      for (const open of [ONE, TWO, THREE]) {
        for (const width of [380, 450, 550, 700, 900]) {
          const geometry = at(viewport, open, width);
          if (geometry.mode === 'seated') expect(geometry.content).toBeGreaterThanOrEqual(836);
        }
      }
    }
    expect(CONTENT_FLOOR).toBe(836);
  });
});

describe('MP-3-2 seats at 550 from about 1650', () => {
  it('seats one default panel from 1650 and floats it below', () => {
    expect(at(1650, ONE).mode).toBe('seated');
    expect(at(1649, ONE).mode).toBe('floating');
    expect(at(1439, ONE, 380).mode).toBe('floating');
  });
});

describe('MP-3-2 panels equal, never below the floor', () => {
  it('gives every open panel the same width, never under 380', () => {
    for (let viewport = 1280; viewport <= 2600; viewport += 7) {
      for (const open of [ONE, TWO, THREE]) {
        for (const width of [100, 380, 550, 1200]) {
          const geometry = at(viewport, open, width);
          expect(geometry.panelWidth).toBeGreaterThanOrEqual(PANEL_FLOOR);
          expect(geometry.groupWidth).toBe(geometry.panelWidth * geometry.open.length);
        }
      }
    }
  });

  it('holds a stored width under the floor at the floor', () => {
    expect(at(2400, ONE, 120).panelWidth).toBe(380);
  });
});

describe('MP-3-2 drag walks seated to floating', () => {
  it('floats as the width passes the seat line, with no threshold of its own', () => {
    // At 1700, one panel seats up to 1700 - 224 - 40 - 836 = 600 wide.
    expect(at(1700, ONE, 600).mode).toBe('seated');
    expect(at(1700, ONE, 601).mode).toBe('floating');
    expect(at(1700, ONE, 703).mode).toBe('floating');
    expect(at(1700, ONE, 380).mode).toBe('seated');
  });
});
