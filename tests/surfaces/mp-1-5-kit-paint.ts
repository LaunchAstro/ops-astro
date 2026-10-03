// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
//
// MP-1-5's paint on the drawn gallery, read off the browser at each width in
// each theme: the score dials' number weight, the donut's slice fills in
// order, and the sparkline's line, area and end-dot paint. The kit takes these
// from the mockup's charts (the dial's number at 500, the donut's slices in
// the mockup's chart paint order, the sparkline in the accent). Run as its own
// Node process by the named test: it prints the report as JSON.

import { eachGalleryView } from '../visual/gallery-views.ts';

export type PaintView = {
  name: string;
  dialWeights: string[];
  slices: { fill: string; opacity: string }[];
  spark: { line: string; area: string; end: string };
};

/**
 * Runs in the page: the computed paint of the three chart units, read once no
 * transition is running (a colour read mid-transition, even between equal
 * colours, is given in the transition's space, oklab, not the token's).
 */
async function read(): Promise<Omit<PaintView, 'name'>> {
  await Promise.all(document.getAnimations().map((animation) => animation.finished));
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends this function alone
  const state = (unit: string, label: string): string =>
    `[data-catalogue-id="${unit}"] [data-gallery-state="${label}"]`;
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends this function alone
  const style = (selector: string): CSSStyleDeclaration | undefined => {
    const element = document.querySelector(selector);
    return element === null ? undefined : getComputedStyle(element);
  };
  const dials = document.querySelectorAll(
    `${state('DS-COMP-28', 'Score dials, three bands')} .dial__score`,
  );
  const slices = document.querySelectorAll(
    `${state('DS-COMP-28', 'Donut with centre label')} .chart__slice`,
  );
  const spark = `${state('DS-COMP-29', 'Sparkline')} svg.spark`;
  return {
    dialWeights: [...dials].map((dial) => getComputedStyle(dial).fontWeight),
    slices: [...slices].map((slice) => {
      const paint = getComputedStyle(slice);
      return { fill: paint.fill, opacity: paint.opacity };
    }),
    spark: {
      line: style(`${spark} .chart__line`)?.stroke ?? '',
      area: style(`${spark} .chart__area`)?.fill ?? '',
      end: style(`${spark} .chart__end`)?.fill ?? '',
    },
  };
}

async function paintReport(): Promise<PaintView[]> {
  const views: PaintView[] = [];
  await eachGalleryView(async ({ width, theme, page }) => {
    views.push({ name: `gallery@${String(width)}-${theme}`, ...(await page.evaluate(read)) });
  });
  return views;
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(await paintReport())}\n`);
}
