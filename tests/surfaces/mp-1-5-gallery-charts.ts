// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- units are pictured one at a time, in order */
//
// MP-1-5's visual match on the drawn gallery: the chart units (DS-COMP-27,
// 28, 29 and 40) at each width in each theme. Each of the seven shapes is
// drawn inside its unit and the viewport; the line chart is drawn at its
// frame's measured width and redrawn to the new width when the viewport
// narrows; a point's value tooltip shows on hover and on keyboard focus; the
// axis labels are the mono style at 10 px and 45%; and each unit draws
// differently in dark. Run as its own Node process by the MP-1-5 test, whose
// file runs under jsdom: it prints the report as JSON and exits non-zero when
// it cannot draw.

import type { Page } from 'playwright';
import { comparePng } from '../visual/compare.ts';
import { eachGalleryView, entryPicture, WIDTHS } from '../visual/gallery-views.ts';

export const UNITS = ['DS-COMP-27', 'DS-COMP-28', 'DS-COMP-29', 'DS-COMP-40'] as const;

/** Each of the seven shapes: the gallery state it is drawn in, and what draws it. */
export const SHAPES = {
  line: ['DS-COMP-27', 'Line', 'svg .chart__line'],
  column: ['DS-COMP-27', 'Column with dashed line', 'svg .chart__bar'],
  donut: ['DS-COMP-28', 'Donut with centre label', 'svg .chart__slice'],
  gauge: ['DS-COMP-28', 'Gauge with target', 'svg .chart__target'],
  dial: ['DS-COMP-28', 'Score dials, three bands', '.dial svg'],
  sparkline: ['DS-COMP-29', 'Sparkline', 'svg.spark'],
  funnel: ['DS-COMP-40', 'True-scale funnel', '.funnel__step'],
} as const;

type Box = { left: number; right: number; width: number; height: number };

export type ChartView = {
  name: string;
  sideways: number;
  units: Record<string, Box>;
  shapes: Record<string, Box & { count: number }>;
  dashed: string;
  centreLabel: string;
  bands: string[];
  axis: { family: string; size: string; opacity: string };
  line: { frame: number; drawn: number; narrowed: { frame: number; drawn: number } };
  tip: { hover: string; focus: string };
};

/** Runs in the page: where each unit and shape is drawn, and what the shapes carry. */
function read(
  shapes: Record<string, readonly [string, string, string]>,
): Omit<ChartView, 'name' | 'sideways' | 'line' | 'tip'> {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends this function alone
  const boxOf = (element: Element | null | undefined): Box => {
    const box = element?.getBoundingClientRect();
    return {
      left: box?.left ?? -1,
      right: box?.right ?? -1,
      width: box?.width ?? 0,
      height: box?.height ?? 0,
    };
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends this function alone
  const state = (unit: string, label: string): Element | null =>
    document.querySelector(`[data-catalogue-id="${unit}"] [data-gallery-state="${label}"]`);
  const units: Record<string, Box> = {};
  for (const unit of ['DS-COMP-27', 'DS-COMP-28', 'DS-COMP-29', 'DS-COMP-40'])
    units[unit] = boxOf(document.querySelector(`[data-catalogue-id="${unit}"]`));
  const drawn: Record<string, Box & { count: number }> = {};
  for (const [shape, [unit, label, selector]] of Object.entries(shapes)) {
    const found = state(unit, label)?.querySelectorAll(selector) ?? [];
    drawn[shape] = { ...boxOf(found[0]), count: found.length };
  }
  const columnLine = state('DS-COMP-27', 'Column with dashed line')?.querySelector('.chart__line');
  const axis = document.querySelector('[data-catalogue-id="DS-COMP-27"] text.chart__axis');
  const axisStyle = axis === null ? undefined : getComputedStyle(axis);
  const dials = state('DS-COMP-28', 'Score dials, three bands')?.querySelectorAll('.dial') ?? [];
  return {
    units,
    shapes: drawn,
    dashed:
      columnLine === null || columnLine === undefined
        ? 'none'
        : getComputedStyle(columnLine).strokeDasharray,
    centreLabel:
      state('DS-COMP-28', 'Donut with centre label')?.querySelector('.chart__centre')
        ?.textContent ?? '',
    bands: [...dials].map(
      (dial) => [...dial.classList].find((name) => name.startsWith('is-')) ?? '',
    ),
    axis: {
      family: axisStyle?.fontFamily ?? '',
      size: axisStyle?.fontSize ?? '',
      opacity: axisStyle?.opacity ?? '',
    },
  };
}

const LINE = '[data-catalogue-id="DS-COMP-27"] [data-gallery-state="Line"]';

/** The line chart's frame width and the width its drawing was made for. */
function lineWidths(line: string): { frame: number; drawn: number } {
  const frame = document.querySelector(`${line} .chart__frame`);
  const svg = frame?.querySelector('svg');
  return {
    frame: Math.round(frame?.getBoundingClientRect().width ?? -1),
    drawn: Number(svg?.getAttribute('width') ?? -1),
  };
}

/** Narrows the viewport by a fifth and reads the line chart once it has redrawn. */
async function narrowed(page: Page, width: number): Promise<{ frame: number; drawn: number }> {
  const before = await page.evaluate(lineWidths, LINE);
  const size = page.viewportSize() ?? { width, height: 900 };
  await page.setViewportSize({ width: Math.round(width * 0.8), height: size.height });
  await page
    .waitForFunction(
      ({ line, was }) => {
        const frame = document.querySelector(`${line} .chart__frame`);
        const drawn = Number(frame?.querySelector('svg')?.getAttribute('width') ?? was);
        return drawn !== was && drawn === Math.round(frame?.getBoundingClientRect().width ?? -1);
      },
      { line: LINE, was: before.drawn },
      { timeout: 5000 },
    )
    .catch(() => null);
  const after = await page.evaluate(lineWidths, LINE);
  await page.setViewportSize(size);
  return after;
}

/** A point's tooltip, shown by the pointer and then by keyboard focus. */
async function tips(page: Page): Promise<ChartView['tip']> {
  const tip = page.locator(`${LINE} [role="tooltip"]`);
  const text = async (): Promise<string> => ((await tip.isVisible()) ? await tip.innerText() : '');
  await page.locator(`${LINE} .chart__hit`).nth(2).hover();
  const hover = await text();
  await page.mouse.move(0, 0);
  await page.locator(`${LINE} .chart__hit[tabindex="0"]`).focus();
  await page.keyboard.press('ArrowRight');
  const focus = await text();
  await page.locator(`${LINE} .chart__hit`).nth(1).blur();
  return { hover, focus };
}

export async function chartsReport(): Promise<{ views: ChartView[]; sameInDark: string[] }> {
  const views: ChartView[] = [];
  const pictures = new Map<string, Buffer>();
  await eachGalleryView(async ({ width, theme, page, sideways }) => {
    const name = `gallery@${String(width)}-${theme}`;
    const seen = await page.evaluate(read, SHAPES);
    const frame = await page.evaluate(lineWidths, LINE);
    for (const unit of UNITS) pictures.set(`${unit}@${name}`, await entryPicture(page, unit));
    const tip = await tips(page);
    views.push({
      name,
      sideways,
      ...seen,
      line: { ...frame, narrowed: await narrowed(page, width) },
      tip,
    });
  });
  const sameInDark = WIDTHS.flatMap((width) =>
    UNITS.filter((unit) => {
      const light = pictures.get(`${unit}@gallery@${String(width)}-light`) ?? Buffer.alloc(0);
      const dark = pictures.get(`${unit}@gallery@${String(width)}-dark`) ?? Buffer.alloc(0);
      return comparePng(`${unit}@${String(width)}`, light, dark).pass;
    }).map((unit) => `${unit}@${String(width)}`),
  );
  return { views, sameInDark };
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(await chartsReport())}\n`);
}
