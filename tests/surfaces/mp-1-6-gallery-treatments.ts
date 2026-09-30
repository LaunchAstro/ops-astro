// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- markers are hovered one at a time, in order */
//
// MP-1-6's visual match on the drawn gallery: the treatments unit at each
// width in each theme. The not-connected state shows its word and reason with
// no pink and no hatch; the unavailable primary is drawn as an outline and
// its tooltip names the feature on hover; each freshness marker is an
// indicator (no button, hover draws nothing new); only the sample-data cell
// carries the pink. Run as its own Node process by the MP-1-6 test, whose
// file runs under jsdom: it prints the report as JSON and exits non-zero when
// it cannot draw.

import type { Page } from 'playwright';
import { comparePng } from '../visual/compare.ts';
import { eachGalleryView, entryPicture, WIDTHS } from '../visual/gallery-views.ts';

const UNIT = '[data-catalogue-id="MP-1-6"]';
const cell = (label: string): string => `${UNIT} [data-gallery-state="${label}"]`;

export type TreatmentView = {
  name: string;
  sideways: number;
  unit: { left: number; right: number };
  notConnected: { word: boolean; reason: boolean; hatch: string };
  primary: { disabled: boolean; background: string; border: string; tip: string };
  markers: { count: number; buttons: number; hoverDraws: string[] };
  pink: string[];
};

function read(page: Page): Promise<Omit<TreatmentView, 'name' | 'sideways' | 'markers'>> {
  return page.evaluate((unit) => {
    const root = document.querySelector(unit);
    const box = root?.getBoundingClientRect();
    const at = (label: string): Element | null =>
      root?.querySelector(`[data-gallery-state="${label}"]`) ?? null;
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends this function alone
    const shown = (element: Element | null | undefined): boolean =>
      element instanceof HTMLElement && element.checkVisibility() && element.offsetWidth > 0;
    const notconn = at('Not connected')?.querySelector('.notconn');
    const button = at('Unavailable primary')?.querySelector('button');
    const style = button === null || button === undefined ? undefined : getComputedStyle(button);
    // The pink: any drawn element whose ground is the sample-data tint.
    const tint = getComputedStyle(document.documentElement).getPropertyValue('--mock-tint').trim();
    const probe = document.createElement('span');
    probe.style.background = tint;
    document.body.append(probe);
    const pinkGround = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const pink = [...(root?.querySelectorAll('[data-gallery-state] *') ?? [])]
      .filter((el) => getComputedStyle(el).backgroundColor === pinkGround)
      .map((el) => el.closest<HTMLElement>('[data-gallery-state]')?.dataset['galleryState'] ?? '');
    return {
      unit: { left: box?.left ?? -1, right: box?.right ?? Infinity },
      notConnected: {
        word: shown(notconn?.querySelector('.notconn__word')),
        reason: shown(notconn?.querySelector('.notconn__reason')),
        hatch: notconn instanceof Element ? getComputedStyle(notconn).backgroundImage : 'missing',
      },
      primary: {
        disabled: button?.disabled ?? false,
        background: style?.backgroundColor ?? 'missing',
        border: style?.borderTopWidth ?? '0px',
        tip: '',
      },
      pink: [...new Set(pink)],
    };
  }, UNIT);
}

/** Hover each freshness marker: an indicator draws nothing new. */
async function markers(page: Page): Promise<TreatmentView['markers']> {
  const found = page.locator(`${UNIT} .fresh`);
  const count = await found.count();
  const buttons = await page.locator(`${UNIT} .fresh button, ${UNIT} button.fresh`).count();
  const hoverDraws: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const marker = found.nth(index);
    const before = await marker.screenshot({ animations: 'disabled', scale: 'css' });
    await marker.hover();
    const after = await marker.screenshot({ animations: 'disabled', scale: 'css' });
    if (!comparePng('fresh', before, after).pass) hoverDraws.push(String(index));
    await page.mouse.move(0, 0);
  }
  return { count, buttons, hoverDraws };
}

export async function treatmentsReport(): Promise<{
  views: TreatmentView[];
  sameInDark: number[];
}> {
  const views: TreatmentView[] = [];
  const pictures = new Map<string, Buffer>();
  await eachGalleryView(async ({ width, theme, page, sideways }) => {
    const name = `gallery@${width}-${theme}`;
    const seen = await read(page);
    pictures.set(name, await entryPicture(page, 'MP-1-6'));
    await page
      .locator(`${cell('Unavailable primary')} .unavail`)
      .first()
      .hover();
    const tip = page.locator(`${cell('Unavailable primary')} [role="tooltip"]`).first();
    seen.primary.tip = (await tip.isVisible()) ? await tip.innerText() : '';
    await page.mouse.move(0, 0);
    views.push({ name, sideways, ...seen, markers: await markers(page) });
  });
  const sameInDark = WIDTHS.filter((width) => {
    const light = pictures.get(`gallery@${width}-light`) ?? Buffer.alloc(0);
    const dark = pictures.get(`gallery@${width}-dark`) ?? Buffer.alloc(0);
    return comparePng(`MP-1-6@${width}`, light, dark).pass;
  });
  return { views, sameInDark };
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(await treatmentsReport())}\n`);
}
