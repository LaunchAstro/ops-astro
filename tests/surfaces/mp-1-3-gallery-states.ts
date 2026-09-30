// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- entries are captured one at a time, in order */
//
// MP-1-3's visual match on the drawn gallery: every catalogue entry's box,
// its picture, and the three states a person puts a control in (hover on the
// segmented control, keyboard focus on a button, the select opened by a
// click), each read from the browser before and after.
//
// Run as its own Node process (`node tests/surfaces/mp-1-3-gallery-states.ts`)
// by the MP-1-3 test, whose file runs under jsdom: it prints the report as
// JSON and exits non-zero when it cannot draw (no browser, no app).

import type { Page } from 'playwright';
import { comparePng } from '../visual/compare.ts';
import { eachGalleryView, entryPicture, WIDTHS } from '../visual/gallery-views.ts';

type EntryBox = { id: string; left: number; right: number; width: number; height: number };

/** Every gallery entry's box, by catalogue id, in page pixels. */
function entryBoxes(page: Page): Promise<EntryBox[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-catalogue-id]')].map((entry) => {
      const box = entry.getBoundingClientRect();
      const id = entry.dataset['catalogueId'] ?? '';
      return { id, left: box.left, right: box.right, width: box.width, height: box.height };
    }),
  );
}

/** Every entry's picture, by catalogue id. */
async function entryPictures(page: Page, ids: readonly string[]): Promise<Map<string, Buffer>> {
  const pictures = new Map<string, Buffer>();
  for (const id of ids) pictures.set(id, await entryPicture(page, id));
  return pictures;
}

const shotOf = (page: Page, selector: string): Promise<Buffer> =>
  page
    .locator(selector)
    .first()
    .screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' });

type Interactions = {
  hover: { before: Buffer; after: Buffer };
  focus: { before: Buffer; after: Buffer; ring: string };
  select: { closedMenus: number; openMenus: number };
};

/** Hover, keyboard focus and the open select, each captured before and after. */
async function interact(page: Page): Promise<Interactions> {
  const option = '[data-catalogue-id="DS-PRIM-10"] .segmented__opt:not([aria-pressed="true"])';
  const hoverBefore = await shotOf(page, option);
  await page.locator(option).first().hover();
  const hover = { before: hoverBefore, after: await shotOf(page, option) };
  await page.mouse.move(0, 0);

  // The ring (DR-1) is a box shadow outside the button's box: its cell is pictured.
  const cell = '[data-catalogue-id="DS-PRIM-1"] [data-gallery-state="Primary"]';
  const button = `${cell} .btn`;
  const focusBefore = await shotOf(page, cell);
  // Reached by the keyboard (Tab off it and Shift+Tab back), as a keyboard user reaches it.
  await page.locator(button).first().focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  const ring = await page
    .locator(button)
    .first()
    .evaluate((el) => (el.matches(':focus-visible') ? getComputedStyle(el).boxShadow : 'none'));
  const focus = { before: focusBefore, after: await shotOf(page, cell), ring };

  const closed = '[data-catalogue-id="DS-PRIM-5"] [data-gallery-state="Closed"]';
  const visibleMenus = (): Promise<number> =>
    page.locator(`${closed} [role="listbox"]`).filter({ visible: true }).count();
  const closedMenus = await visibleMenus();
  await page.locator(`${closed} [aria-expanded]`).first().click();
  const select = { closedMenus, openMenus: await visibleMenus() };
  return { hover, focus, select };
}

type ViewReport = {
  name: string;
  sideways: number;
  boxes: EntryBox[];
  hoverDiffers: boolean;
  focusDiffers: boolean;
  ring: string;
  select: { closedMenus: number; openMenus: number };
};
export type GalleryReport = { views: ViewReport[]; sameInDark: string[] };

/** The gallery at each width in each theme, measured; entries drawn the same in dark named. */
async function galleryReport(): Promise<GalleryReport> {
  const views: ViewReport[] = [];
  const pictures = new Map<string, Map<string, Buffer>>();
  await eachGalleryView(async ({ width, theme, page, sideways }) => {
    const name = `gallery@${width}-${theme}`;
    const boxes = await entryBoxes(page);
    pictures.set(
      name,
      await entryPictures(
        page,
        boxes.map((box) => box.id),
      ),
    );
    const { hover, focus, select } = await interact(page);
    const differs = (a: Buffer, b: Buffer): boolean => !comparePng(name, a, b).pass;
    views.push({
      name,
      sideways,
      boxes,
      ring: focus.ring,
      select,
      hoverDiffers: differs(hover.before, hover.after),
      focusDiffers: differs(focus.before, focus.after),
    });
  });
  const sameInDark: string[] = [];
  for (const width of WIDTHS) {
    const light = pictures.get(`gallery@${width}-light`) ?? new Map<string, Buffer>();
    for (const [id, picture] of light) {
      const dark = pictures.get(`gallery@${width}-dark`)?.get(id) ?? Buffer.alloc(0);
      if (comparePng(`${id}@${width}`, picture, dark).pass) sameInDark.push(`${id}@${width}`);
    }
  }
  return { views, sameInDark };
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(await galleryReport())}\n`);
}
