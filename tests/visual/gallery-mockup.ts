// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- widths, themes and units run one at a time,
   in order: one browser context at a time. */
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
// treatments). The mockup's own markup for the component is drawn at one
// fixed place by each side's stylesheet, the mockup's and the kit's, and the
// two pictures are compared (compare.ts): any difference beyond the harness
// tolerance fails, and a component the mockup page does not draw fails. Both
// pictures are written for a person to set side by side.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { madeUpSession, serveApp } from './app-pages.ts';
import { load, MOCKUP_ORIGIN, openSide, type Side } from './capture.ts';
import { comparePng } from './compare.ts';
import { WIDTHS } from './gallery-views.ts';
import {
  checkMockupTree,
  checkRenderer,
  fetchAssets,
  liveRenderer,
  MODE,
  readAssets,
  readPacket,
  themesOf,
  type Packet,
  type Theme,
} from './packet.ts';

/** Any client: a canonical pattern's `:client` takes one segment, and the mockup's pages are static. */
const CLIENT = 'sample-client';
const INVOICES = `/clients/${CLIENT}/account/`;
const WORKBENCH = `/clients/${CLIENT}/workbench/`;

/**
 * Each ticket's components and the mockup unit each is compared with. `same`:
 * the kit draws the unit as the mockup does. `redrawn`: the ticket itself
 * redraws the mockup's treatment (MP-1-6: the freshness marker an indicator,
 * not a sync button; an unavailable control not the faded unwired button), so
 * the pictures must differ. `draw`: markup of the mockup's own class, drawn in
 * place of the unit found, where the treatment is the class alone.
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
  },
  {
    ticket: 'MP-1-6',
    what: 'sample-mark',
    address: WORKBENCH,
    component: '.is-mock',
    expect: 'same',
    // The mark is the class alone: drawn on one fixed box, not on a region whose size is its page's.
    draw: '<div class="is-mock" style="width:160px;height:48px"></div>',
  },
  {
    ticket: 'MP-1-6',
    what: 'unavailable-control',
    address: INVOICES,
    component: '.btn[data-unwired]',
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

/** Draws the markup at one fixed place above the page, on the page's ground; returns its box. */
function place(markup: string): Box {
  document.querySelector('#mockup-compare')?.remove();
  const box = document.createElement('div');
  box.id = 'mockup-compare';
  box.style.cssText =
    'position:fixed;left:8px;top:8px;z-index:2147483647;display:flex;padding:4px;background:var(--bg)';
  box.innerHTML = markup;
  document.body.append(box);
  const drawn = box.getBoundingClientRect();
  return { x: drawn.x, y: drawn.y, width: Math.ceil(drawn.width), height: Math.ceil(drawn.height) };
}

/** A picture of the placed box; a page that reports no box is pictured whole, which never matches. */
const picture = (page: Page, box?: unknown): Promise<Buffer> => {
  const clip = typeof box === 'object' && box !== null && 'width' in box ? (box as Box) : undefined;
  const options = { animations: 'disabled', caret: 'hide', scale: 'css' } as const;
  return page.screenshot(clip === undefined ? options : { ...options, clip });
};

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
    const markup = await page.evaluate(markupOf, unit.component);
    if (markup === '') {
      lines.push(`FAIL ${label}: ${unit.component} not in the mockup page at ${unit.address}`);
      continue;
    }
    const drawn = 'draw' in unit ? unit.draw : markup;
    const left = await picture(page, await page.evaluate(place, drawn));
    const right = await picture(gallery, await gallery.evaluate(place, drawn));
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
async function oneView(
  sides: { mockup: Side; gallery: Side },
  at: { packet: Packet; app: URL; width: number; theme: Theme; out: string },
): Promise<string[]> {
  const name = `@${String(at.width)}-${at.theme}`;
  const board = await load(sides.mockup, at.packet, `${MOCKUP_ORIGIN}/agency/projects/`);
  const gallery = await load(sides.gallery, at.packet, new URL('/gallery/', at.app).href);
  const [left, right] = [await board.evaluate(textFamilies), await gallery.evaluate(textFamilies)];
  writeFileSync(join(at.out, `mockup-board${name}.png`), await picture(board));
  writeFileSync(join(at.out, `gallery${name}.png`), await picture(gallery));
  const same = JSON.stringify(left) === JSON.stringify(right);
  const families = `${same ? 'ok' : 'FAIL'} families${name}: mockup ${left.join(', ')}; gallery ${right.join(', ')}`;
  return [families, ...(await compareUnits(sides.mockup, gallery, { ...at, name }))];
}

const mockupDir = process.env['MOCKUP_DIR'];
if (mockupDir === undefined) throw new Error('visual: set MOCKUP_DIR to the pinned mockup clone');
const at = process.argv.indexOf('--out');
const out =
  at === -1 ? mkdtempSync(join(tmpdir(), 'gallery-mockup-')) : (process.argv[at + 1] ?? '');
mkdirSync(out, { recursive: true });
const packet = readPacket();
const tree = checkMockupTree(mockupDir, packet.mockup);
await fetchAssets(readAssets(), packet);
const browser = await chromium.launch(MODE);
checkRenderer(packet, liveRenderer(browser, MODE));
const { app, close } = await serveApp();
const lines: string[] = [];
try {
  const session = madeUpSession(app, join(out, 'session'));
  for (const width of WIDTHS) {
    for (const theme of themesOf(packet)) {
      const mockup = await openSide(browser, packet, width, { mockupDir, tree, theme });
      const gallery = await openSide(browser, packet, width, { app, session, colorScheme: theme });
      try {
        lines.push(...(await oneView({ mockup, gallery }, { packet, app, width, theme, out })));
      } finally {
        await Promise.all([mockup.context.close(), gallery.context.close()]);
      }
    }
  }
} finally {
  rmSync(join(out, 'session'), { recursive: true, force: true });
  await browser.close();
  await close();
}
writeFileSync(join(out, 'summary.txt'), `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
process.exitCode = lines.every((line) => line.startsWith('ok')) ? 0 : 1;
