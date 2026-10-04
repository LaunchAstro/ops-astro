// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
//
// MP-1-3's components as the gallery lays them out, read off the browser at
// each width in each theme: the drawn width of chosen states' components, the
// width of their state, and each component's own width (a copy of it drawn
// beside the gallery at its content's width). An inline control (a button, a
// chip) draws at its own width, as in a page; a block (a banner, a field, the
// meter, an axis chart) fills its state. Run as its own Node process by the
// named test: it prints the report as JSON.

import { eachGalleryView } from '../visual/gallery-views.ts';

/** Gallery entry and state, and whether its component is inline (own width) or a block (fills). */
export const CHOSEN = [
  { unit: 'DS-PRIM-1', state: 'Primary', kind: 'inline' },
  { unit: 'DS-PRIM-1', state: 'Secondary', kind: 'inline' },
  { unit: 'DS-PRIM-11', state: 'Outline', kind: 'inline' },
  { unit: 'DS-PRIM-15', state: 'Chip, ok', kind: 'inline' },
  { unit: 'DS-PRIM-3', state: 'Default', kind: 'block' },
  { unit: 'DS-PRIM-22', state: 'Warning', kind: 'block' },
  { unit: 'DS-PRIM-23', state: 'Default with target', kind: 'block' },
  { unit: 'DS-PRIM-32', state: 'Region', kind: 'block' },
  { unit: 'DS-COMP-27', state: 'Line', kind: 'block' },
] as const;

export type Measured = {
  unit: string;
  state: string;
  drawn: number;
  stateWidth: number;
  own: number;
};
export type WidthView = { name: string; measured: Measured[] };

/** Runs in the page: each chosen component's drawn, state and own widths. */
function read(chosen: readonly { unit: string; state: string }[]): Measured[] {
  return chosen.map(({ unit, state }) => {
    const figure = document.querySelector(
      `[data-catalogue-id="${unit}"] [data-gallery-state="${state}"]`,
    );
    const component = figure?.querySelector(':scope > :not(figcaption)');
    if (!(figure instanceof HTMLElement) || !(component instanceof HTMLElement))
      return { unit, state, drawn: -1, stateWidth: -1, own: -1 };
    const holder = document.createElement('div');
    holder.style.cssText = 'position:absolute;left:0;top:0;width:max-content;visibility:hidden';
    holder.append(component.cloneNode(true));
    figure.append(holder);
    const own = (holder.firstElementChild as HTMLElement).getBoundingClientRect().width;
    holder.remove();
    // An empty block in the state is as wide as the state's content.
    const probe = document.createElement('div');
    figure.append(probe);
    const stateWidth = probe.getBoundingClientRect().width;
    probe.remove();
    return { unit, state, drawn: component.getBoundingClientRect().width, stateWidth, own };
  });
}

async function widthReport(): Promise<WidthView[]> {
  const views: WidthView[] = [];
  await eachGalleryView(async ({ width, theme, page }) => {
    views.push({
      name: `gallery@${String(width)}-${theme}`,
      measured: await page.evaluate(read, CHOSEN),
    });
  });
  return views;
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(await widthReport())}\n`);
}
