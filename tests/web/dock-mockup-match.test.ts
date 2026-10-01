// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- widths, themes and clicks run one at a
   time, in order, so each report line comes in a fixed order. */
//
// The dock's mockup-match legs (MP-3-1, MP-3-3), on MP-1-7's width-and-theme
// harness in a real browser on the served app: the rail at rest, a panel
// head, two panels stacked (stack2) and the tab's hover motion.
//
// The mockup's values come from `tests/visual/look/dock.mockup.json` (look.ts
// --measure at 7066bad) and, where no person can open a panel in the mockup
// (its strip is off screen at 900 and below, D9) or the state takes a
// shift-click, from the mockup inventory's measured captures (ops-astro-roadmap
// `.local/mockup-inventory-2026-09-26/captures/DOCK/`, numbers copied below).
// The pinned values are re-measured from the mockup itself locally
// (`MOCKUP_DIR=<clone> node tests/visual/look.ts --measure --screen dock`);
// evidence is kept under the roadmap's
// `.local/design-system-2026-09-26/evidence/SL06-dock-mockup-match/`.

import { readFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { load } from '../visual/capture.ts';
import type { Theme } from '../visual/packet.ts';
import { addressOf } from '../visual/report.ts';
import { onDockSides, type DockSide } from './dock-harness.ts';

const WIDTHS = [1480, 900, 390];
const THEMES: readonly Theme[] = ['light', 'dark'];

interface Pinned {
  readonly probes: Readonly<Record<string, Readonly<Record<string, Record<string, string>>>>>;
}
const PINNED = JSON.parse(
  readFileSync(new URL('../visual/look/dock.mockup.json', import.meta.url), 'utf8'),
) as Pinned;
/** One pinned mockup value, as a number. */
const pinned = (probe: string, at: string, prop: string): number =>
  Number(PINNED.probes[`dock.${probe}`]?.[at]?.[prop]?.replace('px', '') ?? Number.NaN);

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
/** In the page: each selector's first box, rounded, or null when it draws none. */
function boxesOf(selectors: string[]): (Box | null)[] {
  return selectors.map((selector) => {
    const element = document.querySelector(selector);
    if (element === null) return null;
    const { x, y, width, height } = element.getBoundingClientRect();
    const round = Math.round;
    return { x: round(x), y: round(y), width: round(width), height: round(height) };
  });
}

/** Panels opened the way a person would: the first with a click, the rest stacked with shift. */
async function openPanels(page: Page, ids: readonly string[]): Promise<void> {
  for (const [index, id] of ids.entries()) {
    const tab = page.locator(`.dock__tab[data-panel="${id}"]`);
    await tab.click(index === 0 ? {} : { modifiers: ['Shift'] });
  }
  await page.locator('.dpanel').first().waitFor();
  await page.mouse.move(0, 0);
}

/** One line per width and theme, from a page of the board on each signed-in side. */
async function linesOn(
  widths: readonly number[],
  each: (page: Page, at: DockSide) => Promise<string>,
): Promise<string[]> {
  const lines: string[] = [];
  await onDockSides(widths, THEMES, async (at) => {
    const board = addressOf('agency:projects-board', { key: 'T-1' }) ?? '/';
    const page = await load(at.side, at.packet, new URL(board, at.app).href);
    try {
      lines.push(`${String(at.width)}-${at.theme}: ${await each(page, at)}`);
    } finally {
      await page.close();
    }
  });
  return lines;
}

const expected = (widths: readonly number[], line: (width: number) => string): string[] =>
  widths.flatMap((width) => THEMES.map((theme) => `${String(width)}-${theme}: ${line(width)}`));

/** The rail at rest: beside the page, against the pinned mockup rail; below 900, the strip. */
async function railAtRest(page: Page, at: DockSide): Promise<string> {
  const [rail] = await page.evaluate(boxesOf, ['.dock__rail']);
  if (rail === null || rail === undefined) return 'no rail';
  if (at.width <= 900) {
    // On screen at rest (R33), where the mockup leaves it under the window (D9).
    const bottom = rail.y + rail.height;
    const edge = bottom === at.packet.height ? 'on the bottom edge' : `bottom at ${String(bottom)}`;
    return `${String(rail.width)} wide, ${String(rail.height)} tall, ${edge}`;
  }
  // The mockup's rail is 286 tall for eight doors; this one holds fewer (R34),
  // so its middle, not its top, is held where the mockup's middle is.
  const key = `${String(at.width)}-${at.theme}`;
  const middle = pinned('rail-rest', key, 'box.y') + pinned('rail-rest', key, 'box.height') / 2;
  const right = pinned('rail-rest', key, 'box.x') + pinned('rail-rest', key, 'box.width');
  const ownMiddle = rail.y + rail.height / 2;
  const flush = rail.x + rail.width === right ? 'flush' : String(rail.x + rail.width);
  const centred =
    Math.abs(ownMiddle - middle) <= 1
      ? 'centred'
      : `middle ${String(ownMiddle)}, not ${String(middle)}`;
  return `${String(rail.width)} wide, right edge ${flush}, ${centred}`;
}

describe('MP-3-1 mockup match: dock-rest and a panel head', () => {
  it('MP-3-1 the rail at rest sits flush and centred on the right edge below the app strip at 1480, and the strip lies on the bottom edge at 900 and 390, light and dark', async () => {
    const lines = await linesOn(WIDTHS, railAtRest);
    expect(lines).toEqual(
      expected(WIDTHS, (width) =>
        width > 900
          ? '40 wide, right edge flush, centred'
          : `${String(width)} wide, 40 tall, on the bottom edge`,
      ),
    );
  }, 600_000);

  it('MP-3-1 a panel head is as tall as the pinned mockup head and spans its panel at 1480, 900 and 390 (inventory p-team: 900 and 390 wide), light and dark', async () => {
    const lines = await linesOn(WIDTHS, async (page) => {
      await openPanels(page, ['team']);
      const [head, panel] = await page.evaluate(boxesOf, ['.dpanel__head', '.dpanel']);
      return `head ${String(head?.height)} tall, ${String(head?.width)} wide in a ${String(panel?.width)} panel`;
    });
    const tall = String(pinned('head', '1480-light', 'box.height'));
    expect(lines).toEqual(
      expected(WIDTHS, (width) => {
        // Beside the page the panel's 1 px left border is the panel's own.
        const panel = width > 900 ? 550 : width;
        return `head ${tall} tall, ${String(width > 900 ? panel - 1 : panel)} wide in a ${String(panel)} panel`;
      }),
    );
  }, 600_000);
});

/**
 * stack2 in the inventory's captures (light; dark draws the same boxes): two
 * panels side by side, 550 each at 1480 and 1700 (floating, from x 380 and
 * 600) and 538 each at 1300 (from x 224), all from the app strip's foot (45);
 * stacked under the content, 876 wide, at 1100; at 900 and below only the
 * last opened draws, the window's width.
 */
const STACK2: Readonly<Record<number, string>> = {
  1700: 'side by side: 600+550, 1150+550, top 45',
  1480: 'side by side: 380+550, 930+550, top 45',
  1300: 'side by side: 224+538, 762+538, top 45',
  1100: 'stacked: 224+876, 224+876',
  900: 'one: 0+900',
  390: 'one: 0+390',
};
const STACK_WIDTHS = Object.keys(STACK2)
  .map(Number)
  .toSorted((a, b) => b - a);

/** In the page: how the drawn panels lie, and which sits at the outer (right) edge. */
function stackOf(): string {
  const panels = [...document.querySelectorAll<HTMLElement>('.dpanel')]
    .map((panel) => ({ id: panel.dataset['panelId'], box: panel.getBoundingClientRect() }))
    .filter((panel) => panel.box.width > 0)
    .map(({ id, box }) => ({
      id,
      y: Math.round(box.y),
      x: Math.round(box.x),
      span: `${String(Math.round(box.x))}+${String(Math.round(box.width))}`,
    }));
  const tops = new Set(panels.map((panel) => panel.y));
  const all = panels.map((panel) => panel.span).join(', ');
  if (panels.length === 1) return `one: ${all}`;
  if (tops.size > 1) return `stacked: ${all}`;
  const byX = panels.toSorted((a, b) => a.x - b.x);
  const outer = byX.at(-1)?.id ?? 'none';
  return `side by side: ${byX.map((panel) => panel.span).join(', ')}, top ${[...tops].join('')}, ${outer} outer`;
}

describe('MP-3-3 mockup match: stack2', () => {
  it('MP-3-3 two stacked panels lie as the inventory stack2 does at 1700, 1480, 1300, 1100, 900 and 390, light and dark, the higher-ranked at the outer edge', async () => {
    const lines = await linesOn(STACK_WIDTHS, async (page) => {
      await openPanels(page, ['team', 'notifs']);
      return page.evaluate(stackOf);
    });
    // Notifications ranks above Team on the rail (DR-59), so it takes the outer edge.
    expect(lines).toEqual(
      expected(STACK_WIDTHS, (width) =>
        width > 1279 ? `${STACK2[width] ?? ''}, notifs outer` : (STACK2[width] ?? ''),
      ),
    );
  }, 600_000);

  it.todo(
    'MP-3-3 the sheet and phone heights: min(46dvh, 520) per sheet panel and min(72dvh, 560) on a phone, as stack2 and p-team draw (waits on the layout default in apps/web/src/dock/use-layout.ts, outside the look piece)',
  );
});

/** In the page: the first tab's colour and ground transitions, and the --ease token. */
function tabMotion(): string {
  const tab = document.querySelector('.dock__tab');
  if (tab === null) return 'no tab';
  const style = getComputedStyle(tab);
  const ease = getComputedStyle(document.documentElement).getPropertyValue('--ease').trim();
  const props = style.transitionProperty.split(', ');
  const durations = style.transitionDuration.split(', ');
  // A comma inside cubic-bezier() does not part two easings.
  const easings = style.transitionTimingFunction.split(/,\s*(?![^(]*\))/u);
  const each = ['color', 'background-color'].map((prop) => {
    const at = props.indexOf(prop);
    if (at === -1) return `${prop} none`;
    const easing = easings[at] === ease ? '--ease' : String(easings[at]);
    return `${prop} ${String(durations[at])} ${easing}`;
  });
  return [...each, `--ease ${ease}`].join('; ');
}

describe('MP-3-1 tab hover motion', () => {
  it('MP-3-1 a dock tab changes colour and ground over 120 ms with --ease, read from its computed style', async () => {
    const lines = await linesOn([1480], async (page) => {
      // The harness asks for reduced motion; the motion law is read without it.
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      return page.evaluate(tabMotion);
    });
    const motion =
      'color 0.12s --ease; background-color 0.12s --ease; --ease cubic-bezier(0.16, 1, 0.3, 1)';
    expect(lines).toEqual(expected([1480], () => motion));
  }, 600_000);
});
