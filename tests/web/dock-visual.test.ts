// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- widths, themes and pages run one at a time,
   in order, so each capture and report line comes in a fixed order. */
//
// The dock's visual legs, on MP-1-7's width-and-theme harness in a real
// browser: the rail, its callout, Close all and a panel head captured at
// 1480, 900 and 390 in light and dark (MP-3-1), and every page measured at
// 390 with the dock at rest and with a panel open (MP-3-3).
//
// The mockup-match legs, which were todo here, are in
// dock-mockup-match.test.ts: the rail at rest and a panel head held to the
// pinned mockup (Team stands in for Clients, which this build does not
// register), two panels stacked (stack2) and the tab's hover motion.

import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { load, shoot } from '../visual/capture.ts';
import { comparePng } from '../visual/compare.ts';
import { scrollMetrics } from '../visual/drift.ts';
import { addressOf, builtPages, needsSession, overflowOf } from '../visual/report.ts';
import { onDockSides, type DockSide } from './dock-harness.ts';

const WIDTHS = [1480, 900, 390];
const REGIONS = ['rail', 'callout', 'closeall', 'head'];
const TAB = '.dock__tab[data-panel="settings"]';

/** The rail and its callout at rest, then Close all and the panel head with Settings open. */
async function captureDock(at: DockSide): Promise<{ name: string; png: Buffer }[]> {
  const { side, packet, app, width, theme, mask } = at;
  const page = await load(
    side,
    packet,
    new URL(addressOf('agency:projects-board', { key: 'T-1' }) ?? '/', app).href,
  );
  try {
    const name = `dock@${width}-${theme}`;
    expect(await page.locator('.dock__closeall').count(), `${name} Close all at rest`).toBe(0);
    await page.locator(TAB).hover();
    const rest = await shoot(page, name, { rail: '.dock__rail', callout: '.dock__tablabel' }, mask);
    await page.locator(TAB).click();
    await page.locator('.dpanel__head').waitFor();
    await page.mouse.move(0, 0);
    const open = await shoot(
      page,
      name,
      { closeall: '.dock__closeall', head: '.dpanel__head' },
      mask,
    );
    expect(await page.locator('.dpanel__name').textContent()).toBe('Settings');
    return [...rest, ...open];
  } finally {
    await page.close();
  }
}

describe('MP-3-1 harness captures', () => {
  it('MP-3-1 harness captures: rail, callout, Close all and a panel head at 1480, 900 and 390, light and dark', async () => {
    const pictures = new Map<string, Buffer>();
    await onDockSides(WIDTHS, ['light', 'dark'], async (at) => {
      for (const shot of await captureDock(at)) pictures.set(shot.name, shot.png);
    });
    // Each region at each width in each theme, and dark draws it differently from light.
    for (const width of WIDTHS) {
      for (const region of REGIONS) {
        const light = pictures.get(`dock@${width}-light#${region}`) ?? Buffer.alloc(0);
        const dark = pictures.get(`dock@${width}-dark#${region}`) ?? Buffer.alloc(0);
        expect(light.length, `${region} at ${width} light`).toBeGreaterThan(0);
        expect(dark.length, `${region} at ${width} dark`).toBeGreaterThan(0);
        const same = comparePng(`dock@${width}#${region}`, light, dark);
        expect(same.pass, `${region} at ${width}: dark draws the same as light`).toBe(false);
      }
    }
  }, 600_000);
});

/** In the page: the strip's and the open panel's boxes, and the window's height. */
function dockBoxes(): {
  rail: { left: number; right: number; bottom: number } | null;
  panel: { left: number; right: number } | null;
  height: number;
} {
  const rail = document.querySelector('.dock__rail')?.getBoundingClientRect();
  const panel = document.querySelector('.dpanel')?.getBoundingClientRect();
  return {
    rail: rail === undefined ? null : { left: rail.left, right: rail.right, bottom: rail.bottom },
    panel: panel === undefined ? null : { left: panel.left, right: panel.right },
    height: innerHeight,
  };
}

/** One report line: sideways scroll, the strip on screen, and the panel inside the window. */
async function measure(page: Page, id: string, state: 'rest' | 'open'): Promise<string> {
  const { rail, panel, height } = await page.evaluate(dockBoxes);
  const overflow = overflowOf(await page.evaluate(scrollMetrics));
  const strip = rail !== null && rail.left >= 0 && rail.right <= 390 && rail.bottom <= height;
  const fits =
    state === 'rest' ? panel === null : panel !== null && panel.left >= 0 && panel.right <= 390;
  return `${id}@390 ${state}: overflow ${overflow}, strip ${strip ? 'on' : 'off'} screen, panel ${fits ? 'fits' : 'does not fit'}`;
}

const pagesWithDock = (): string[] => builtPages().filter((id) => needsSession(id));

describe('MP-3-3 no horizontal overflow at 390', () => {
  it('measured at 390 on every page with the width-and-theme harness, the dock at rest and with a panel open', async () => {
    const lines: string[] = [];
    await onDockSides([390], ['light'], async ({ side, packet, app }) => {
      for (const id of pagesWithDock()) {
        const page = await load(
          side,
          packet,
          new URL(addressOf(id, { key: 'T-1' }) ?? '/', app).href,
        );
        try {
          lines.push(await measure(page, id, 'rest'));
          await page.locator(TAB).click();
          await page.locator('.dpanel').waitFor();
          lines.push(await measure(page, id, 'open'));
        } finally {
          await page.close();
        }
      }
    });
    expect(pagesWithDock().length).toBeGreaterThan(0);
    expect(lines).toEqual(
      pagesWithDock().flatMap((id) => [
        `${id}@390 rest: overflow 0, strip on screen, panel fits`,
        `${id}@390 open: overflow 0, strip on screen, panel fits`,
      ]),
    );
  }, 600_000);
});
