// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- units run one at a time, in order: one
   browser context at a time. */
//
// The local half of U04's visual-match legs (MP-1-2 3, MP-1-3 3, MP-1-6 3):
// the pinned mockup beside the component gallery, in the pinned renderer, at
// 1480, 900 and 390 in light and dark. Needs the private mockup, so it runs
// where the mockup is (ruling (a)); the required checks draw the gallery
// alone (gallery-views.ts).
//
//   MOCKUP_DIR=<clone of the mockup> node tests/visual/gallery-mockup.ts --out DIR
//
// MP-1-2: the families each side draws its text in are the same three.
// MP-1-3 and MP-1-6: each component the ticket names is compared pixel by
// pixel with its unit on the mockup page that draws it (the Invoices page and
// the channel workbench, by their canonical addresses, for MP-1-6's
// treatments). The gallery side is the component as the gallery renders it,
// photographed where it stands; nothing is drawn onto the gallery page. The
// mockup side is that same markup drawn at one fixed place on the mockup page
// by the mockup's stylesheet, in a host as wide as the gallery's picture, or,
// for a treatment the ticket redraws, the mockup's own markup for the unit.
// The two pictures are compared
// (compare.ts): any difference beyond the harness tolerance fails, and so
// does a component the mockup page or the gallery does not draw, or one that
// cannot be photographed. Both pictures are written for a person to set side
// by side.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { load, MOCKUP_ORIGIN, type Side } from './capture.ts';
import { comparePng } from './compare.ts';
import { besideMockup, type MockupView } from './mockup-run.ts';
import type { Packet } from './packet.ts';

/** Any client: a canonical pattern's `:client` takes one segment, and the mockup's pages are static. */
const CLIENT = 'sample-client';
const INVOICES = `/clients/${CLIENT}/account/`;
const WORKBENCH = `/clients/${CLIENT}/workbench/`;

/**
 * Each ticket's components and the mockup unit each is compared with. `same`:
 * the kit draws the unit as the mockup does. `redrawn`: the ticket itself
 * redraws the mockup's treatment (MP-1-6: the freshness marker an indicator,
 * not a sync button; an unavailable control not the faded unwired button), so
 * the pictures must differ. `gallery`: the kit's own selector, where the
 * ticket gives the component other markup than the mockup's.
 */
const UNITS = [
  {
    ticket: 'MP-1-3',
    what: 'primary-button',
    address: INVOICES,
    component: '.btn--primary',
    expect: 'same',
  },
  {
    ticket: 'MP-1-3',
    what: 'secondary-button',
    address: WORKBENCH,
    component: '.btn--secondary:not([data-unwired])',
    expect: 'same',
  },
  { ticket: 'MP-1-3', what: 'chip', address: INVOICES, component: '.chip', expect: 'same' },
  {
    ticket: 'MP-1-3',
    what: 'meter',
    address: WORKBENCH,
    component: '.meter',
    expect: 'same',
    // No width of its own: it fills its host on the page, so its copy fills the host here.
    fills: true,
  },
  {
    ticket: 'MP-1-6',
    what: 'sample-mark',
    address: WORKBENCH,
    component: '.is-mock',
    expect: 'same',
    // A named FAIL, for three causes. The tile's padding: the mockup pads a
    // tile only in its row (`.statrow > .stat`), the kit pads the tile itself
    // (DS-PRIM-24), so the copy drawn outside a row has none. The label's line
    // height: 1.5 in the mockup, off the one type scale; the kit keeps its
    // eyebrow's 1.4 (drift, not copied). The word chip: the mockup's sheet has
    // no rule for the kit's `.mocktag` (its own chip is `.unwired-tag`). At
    // 640 and under, the mockup's figure steps down to 28 px; MP-1-4 dropped
    // that step so a stat never reflows.
  },
  {
    ticket: 'MP-1-6',
    what: 'unavailable-control',
    address: INVOICES,
    component: '.btn[data-unwired]',
    // The kit's unavailable control: disabled, its tooltip naming the feature.
    gallery: '.btn[disabled][title]',
    expect: 'redrawn',
  },
  {
    ticket: 'MP-1-6',
    what: 'freshness-invoices',
    address: INVOICES,
    component: '.fresh',
    expect: 'redrawn',
  },
  {
    ticket: 'MP-1-6',
    what: 'freshness-workbench',
    address: WORKBENCH,
    component: '.fresh',
    expect: 'redrawn',
  },
] as const;

type Box = { x: number; y: number; width: number; height: number };

/** The first family of every element that draws its own text. */
function textFamilies(): string[] {
  const families = new Set<string>();
  for (const element of document.querySelectorAll('body *')) {
    const own = [...element.childNodes].some(
      (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
    );
    if (!own || !(element instanceof HTMLElement) || !element.checkVisibility()) continue;
    const first = getComputedStyle(element).fontFamily.split(',')[0] ?? '';
    families.add(first.trim().replaceAll('"', ''));
  }
  return [...families].toSorted();
}

/**
 * The markup of the first drawn element the selector finds, else of the first
 * in the page (a unit in a pane not shown on arrival), or '' when there is none.
 */
function markupOf(selector: string): string {
  const all = [...document.querySelectorAll(selector)];
  const drawn = all.find((element) => element instanceof HTMLElement && element.checkVisibility());
  return (drawn ?? all[0])?.outerHTML ?? '';
}

/**
 * Draws the markup at one fixed place above the page, on the page's ground, in
 * a host as wide as the gallery draws the component: a unit with no width of
 * its own (`fills`, the meter) fills it, one with its own width keeps it.
 * Returns its box.
 */
function place(copy: { markup: string; width: number; fills: boolean }): Box {
  document.querySelector('#mockup-compare')?.remove();
  const box = document.createElement('div');
  box.id = 'mockup-compare';
  box.style.cssText =
    'position:fixed;left:8px;top:8px;z-index:2147483647;display:flex;box-sizing:content-box;padding:4px;background:var(--bg)';
  box.style.width = `${String(copy.width)}px`;
  box.innerHTML = copy.markup;
  if (copy.fills && box.firstElementChild instanceof HTMLElement)
    box.firstElementChild.style.flex = '1 1 auto';
  document.body.append(box);
  const drawn = box.getBoundingClientRect();
  return { x: drawn.x, y: drawn.y, width: Math.ceil(drawn.width), height: Math.ceil(drawn.height) };
}

const SHOT = { animations: 'disabled', caret: 'hide', scale: 'css' } as const;

/** A picture of the whole page. */
const picture = (page: Page): Promise<Buffer> => page.screenshot(SHOT);

/** A PNG's width in pixels, from its header. */
const pngWidth = (png: Buffer): number => png.readUInt32BE(16);

/**
 * A picture of the first shown element the selector finds, where it stands.
 * The gallery lays components at fractional heights (the primary button at y 226.89),
 * so a gallery picture can take one more row of ground than the copy, drawn at
 * a whole pixel: the named cause of a 1 px taller gallery unit.
 */
const unitPicture = (page: Page, selector: string): Promise<Buffer> =>
  page.locator(`${selector}:visible >> nth=0`).screenshot({ ...SHOT, timeout: 10_000 });

/** The drawn component of each side, or the reason one side has none to compare. */
async function pictures(
  page: Page,
  gallery: Page,
  unit: (typeof UNITS)[number],
): Promise<{ left: Buffer; right: Buffer } | string> {
  const mockupMarkup = await page.evaluate(markupOf, unit.component);
  if (mockupMarkup === '') return `${unit.component} not in the mockup page at ${unit.address}`;
  const kit = 'gallery' in unit ? unit.gallery : unit.component;
  const galleryMarkup = await gallery.evaluate(markupOf, kit);
  if (galleryMarkup === '') return `${kit} not in the gallery`;
  try {
    const right = await unitPicture(gallery, kit);
    const markup = unit.expect === 'redrawn' ? mockupMarkup : galleryMarkup;
    const fills = 'fills' in unit && unit.fills;
    await page.evaluate(place, { markup, width: pngWidth(right), fills });
    return { left: await unitPicture(page, '#mockup-compare > *'), right };
  } catch (error) {
    return `not photographed (${error instanceof Error ? error.message.split('\n')[0] : 'unknown'})`;
  }
}

/** Each unit compared at one width in one theme: a result line per unit. */
async function compareUnits(
  mockup: Side,
  gallery: Page,
  at: { packet: Packet; name: string; out: string },
): Promise<string[]> {
  const lines: string[] = [];
  const pages = new Map<string, Page>();
  for (const unit of UNITS) {
    const label = `${unit.ticket} ${unit.what}${at.name}`;
    const page =
      pages.get(unit.address) ?? (await load(mockup, at.packet, `${MOCKUP_ORIGIN}${unit.address}`));
    pages.set(unit.address, page);
    const drawn = await pictures(page, gallery, unit);
    if (typeof drawn === 'string') {
      lines.push(`FAIL ${label}: ${drawn}`);
      continue;
    }
    const { left, right } = drawn;
    writeFileSync(join(at.out, `mockup-${unit.ticket}-${unit.what}${at.name}.png`), left);
    writeFileSync(join(at.out, `gallery-${unit.ticket}-${unit.what}${at.name}.png`), right);
    const verdict = comparePng(label, left, right);
    if (unit.expect === 'same')
      lines.push(verdict.pass ? `ok ${label}: the kit draws the mockup's unit` : verdict.line);
    else
      lines.push(
        verdict.pass
          ? `FAIL ${label}: drawn as the mockup's treatment, which ${unit.ticket} redraws`
          : `ok ${label}: redrawn (${verdict.line.replace(/^FAIL [^:]*: /u, '')})`,
      );
  }
  return lines;
}

/** Families and units at one width in one theme. */
async function oneView(sides: { mockup: Side; gallery: Side }, at: MockupView): Promise<string[]> {
  const { name } = at;
  const board = await load(sides.mockup, at.packet, `${MOCKUP_ORIGIN}/agency/projects/`);
  const gallery = await load(sides.gallery, at.packet, new URL('/gallery/', at.app).href);
  const [left, right] = [await board.evaluate(textFamilies), await gallery.evaluate(textFamilies)];
  writeFileSync(join(at.out, `mockup-board${name}.png`), await picture(board));
  writeFileSync(join(at.out, `gallery${name}.png`), await picture(gallery));
  const same = JSON.stringify(left) === JSON.stringify(right);
  const families = `${same ? 'ok' : 'FAIL'} families${name}: mockup ${left.join(', ')}; gallery ${right.join(', ')}`;
  return [families, ...(await compareUnits(sides.mockup, gallery, at))];
}

await besideMockup('gallery-mockup-', oneView);
