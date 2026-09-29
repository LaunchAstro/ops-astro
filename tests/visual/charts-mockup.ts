// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- widths, themes and shapes run one at a
   time, in order: one browser context at a time. */
//
// The local half of MP-1-5's visual match (U05): the mockup's own chart
// drawing beside the kit's, in the pinned renderer, at 1480, 900 and 390 in
// light and dark. Needs the private mockup, so it runs where the mockup is
// (ruling (a)); the required checks draw the gallery's chart units alone
// (tests/surfaces/mp-1-5-gallery-charts.ts).
//
//   MOCKUP_DIR=<clone of the mockup> node tests/visual/charts-mockup.ts --out DIR
//
// Mockup side: the mockup page that draws the shape calls the mockup's own
// assets/charts.js with the gallery unit's data and the page's own options
// (colours), and the result is drawn in the page's own host for that chart,
// so the page's sheet and context apply. Gallery side: the kit component as
// the gallery renders it. The verdict compares the charts' marks, not the
// ground around them: every painted SVG element in order, with its geometry
// (path, radius, centre, dashes, transform, to 0.1 px) and its computed paint
// (fill, stroke, width, opacity, and a text's font and words), and the SVG's
// size. Both pictures are written for a person to set side by side.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { madeUpSession, serveApp } from './app-pages.ts';
import { load, MOCKUP_ORIGIN, openSide, type Side } from './capture.ts';
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
} from './packet.ts';

/** The workbench tab that draws each chart, by its canonical address (routes.json). */
const WORKBENCH = (tab: string): string => `/clients/sample-client/workbench/${tab}/`;
const BRIEF = '/agency/brief/';
const state = (unit: string, label: string): string =>
  `[data-catalogue-id="${unit}"] [data-gallery-state="${label}"]`;

/** What the mockup page is asked to draw: the gallery's data, the page's own options. */
type Call =
  | { kind: 'dial'; label: string; score: number }
  | { kind: 'gauge'; value: number; target: number; color: string }
  | { kind: 'donut'; values: number[]; centre: string; centreLabel: string }
  | { kind: 'sparkline'; values: number[] };

/**
 * Each shape: the mockup page and host it is drawn in, and the gallery's chart.
 * `keep`: a pane the page removes after drawing, held in place so the chart is
 * read where the mockup draws it.
 */
const SHAPES: {
  what: string;
  page: string;
  host: string;
  call: Call;
  gallery: string;
  keep?: string;
}[] = [
  {
    what: 'score-dial',
    page: WORKBENCH('website-performance'),
    host: '.dials > .dial:first-child',
    call: { kind: 'dial', label: 'Performance', score: 94 },
    gallery: `${state('DS-COMP-28', 'Score dials, three bands')} .dial svg`,
  },
  {
    what: 'gauge',
    page: WORKBENCH('calls'),
    host: '#speedGauge',
    // The workbench draws its gauge in the accent (channel-workbench, speedGauge).
    call: { kind: 'gauge', value: 62, target: 75, color: 'var(--accent)' },
    // Mockup drift, not copied: the pinned mockup's real-data snapshot
    // replaces the source list with one that has no call-tracking source, so
    // the workbench draws the gauge and then removes the calls panel with it
    // (applyWorkbenchAvailability, truth.js). No mockup page shows the gauge;
    // the panel is held so the gauge is read in the panel that draws it.
    keep: '[data-panel="calls"]',
    // Drift, not copied (a ruling): the mockup's gauge value is 21 px
    // (charts.js, gauge), off the one type scale; the kit keeps its 20 px, so
    // this unit's value mark stays a named FAIL.
    gallery: `${state('DS-COMP-28', 'Gauge with target')} svg`,
  },
  {
    what: 'donut',
    page: WORKBENCH('traffic-landing'),
    host: '#chanDonut',
    // The workbench's slices take PAINT's colours in order (channel-workbench, chanDonut).
    call: { kind: 'donut', values: [24, 14, 8], centre: '46', centreLabel: 'Enquiries' },
    // Drift, not copied (a ruling): the mockup's donut centre is 19 px
    // (charts.js, donut), off the one type scale; the kit keeps its 20 px, so
    // this unit's centre mark stays a named FAIL.
    gallery: `${state('DS-COMP-28', 'Donut with centre label')} svg`,
  },
  {
    what: 'sparkline',
    page: BRIEF,
    host: '.arc__spark',
    call: { kind: 'sparkline', values: [3, 5, 4, 6, 5, 8, 7, 9] },
    gallery: `${state('DS-COMP-29', 'Sparkline')} svg.spark`,
  },
];

/** Runs before the mockup page's own scripts: on `path` alone, `keep` is never removed. */
function holdRemoval(given: { path: string; keep: string }): void {
  if (location.pathname !== given.path) return;
  // oxlint-disable-next-line typescript/unbound-method -- called with its element below
  const remove = Element.prototype.remove;
  Element.prototype.remove = function held(this: Element): void {
    if (!this.matches(given.keep)) remove.call(this);
  };
}

/**
 * Runs in the mockup page: draws the call with the page's own charts.js into
 * its host, shown if a pane or a closed layer (`details`) holds it; returns the
 * selector of the drawn SVG,
 * or '' when the page has no such host.
 */
async function drawMockup(given: { host: string; call: Call }): Promise<string> {
  const host = document.querySelector(given.host);
  if (!(host instanceof HTMLElement)) return '';
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends this function alone
  const from = (path: string): Promise<Record<string, unknown>> => import(path);
  const charts = (await from('/assets/charts.js')) as Record<string, (...a: unknown[]) => string>;
  const paint = ((await from('/assets/data.js'))['PAINT'] ?? {}) as Record<string, string>;
  const { call } = given;
  const draw = {
    dial: () => call.kind === 'dial' && charts['scoreDial']?.(call.label, call.score),
    gauge: () =>
      call.kind === 'gauge' &&
      charts['gauge']?.(call.value, { target: call.target, color: call.color }),
    donut: () =>
      call.kind === 'donut' &&
      charts['donut']?.(
        call.values.map((value, i) => ({
          value,
          color: [paint['ink'], paint['accent'], paint['lilac']][i],
        })),
        { centre: call.centre, centreLabel: call.centreLabel },
      ),
    sparkline: () => call.kind === 'sparkline' && charts['sparkline']?.(call.values),
  }[call.kind]();
  if (typeof draw !== 'string') return '';
  if (call.kind === 'dial') host.outerHTML = draw;
  else host.innerHTML = draw;
  const drawn = document.querySelector(given.host);
  for (let at = drawn; at !== null; at = at.parentElement) {
    at.removeAttribute('hidden');
    if (at instanceof HTMLDetailsElement) at.open = true;
    if (at instanceof HTMLElement && getComputedStyle(at).display === 'none')
      at.style.display = 'block';
  }
  return `${given.host} svg`;
}

type Marks = { size: [number, number]; marks: string[] };

/** Runs in either page: the SVG's size and its painted marks, in order, as comparable lines. */
function marksOf(selector: string): Marks | undefined {
  const svg = document.querySelector(selector);
  if (svg === null) return undefined;
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends this function alone
  const none = (paint: string): boolean => paint === 'none' || /rgba\([^)]*,\s*0\)$/u.test(paint);
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- page.evaluate sends this function alone
  const tenth = (value: string): string =>
    value
      .replaceAll(/\s+/gu, ' ')
      .replaceAll(/-?\d*\.?\d+(?:e-?\d+)?/gu, (n) => String(Math.round(Number(n) * 10) / 10));
  const shapes = ['d', 'r', 'cx', 'cy', 'x1', 'y1', 'x2', 'y2', 'transform', 'stroke-dasharray'];
  const marks = [...svg.querySelectorAll('path, circle, line, rect, polyline, text')]
    .filter((mark) => {
      const style = getComputedStyle(mark);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > 0 &&
        !(none(style.fill) && none(style.stroke))
      );
    })
    .map((mark) => {
      const style = getComputedStyle(mark);
      const words =
        mark.tagName === 'text'
          ? ` font=${style.fontFamily.split(',')[0] ?? ''} ${style.fontSize} ${style.fontWeight} "${(mark.textContent ?? '').trim()}"`
          : '';
      const geometry = shapes
        .filter((name) => mark.hasAttribute(name))
        .map((name) => ` ${name}=${tenth(mark.getAttribute(name) ?? '')}`)
        .join('');
      return `${mark.tagName}${geometry} fill=${style.fill} stroke=${style.stroke} width=${style.strokeWidth} opacity=${style.opacity}/${style.fillOpacity}/${style.strokeOpacity}${words}`;
    });
  const box = svg.getBoundingClientRect();
  return { size: [Math.round(box.width), Math.round(box.height)], marks };
}

const picture = (page: Page, selector: string): Promise<Buffer> =>
  page
    .locator(selector)
    .first()
    .screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' });

/** One verdict line: the same size and the same marks, or where they first part. */
function verdict(label: string, left: Marks | undefined, right: Marks | undefined): string {
  if (left === undefined) return `FAIL ${label}: the mockup page drew no such chart`;
  if (right === undefined) return `FAIL ${label}: the gallery draws no such chart`;
  if (left.size.join('x') !== right.size.join('x'))
    return `FAIL ${label}: mockup ${left.size.join('x')}, kit ${right.size.join('x')}`;
  const at = [...Array.from({ length: Math.max(left.marks.length, right.marks.length) }).keys()];
  const parts = at.find((i) => left.marks[i] !== right.marks[i]);
  if (parts === undefined) return `ok ${label}: the kit draws the mockup's marks`;
  return `FAIL ${label}: mark ${String(parts + 1)} of ${String(left.marks.length)}/${String(right.marks.length)}\n  mockup ${left.marks[parts] ?? '(none)'}\n  kit    ${right.marks[parts] ?? '(none)'}`;
}

/** Every shape at one width in one theme. */
async function oneView(
  sides: { mockup: Side; gallery: Page },
  at: { packet: Packet; name: string; out: string },
): Promise<string[]> {
  const lines: string[] = [];
  for (const shape of SHAPES) {
    const label = `MP-1-5 ${shape.what}${at.name}`;
    if (shape.keep !== undefined)
      await sides.mockup.context.addInitScript(holdRemoval, { path: shape.page, keep: shape.keep });
    const page = await load(sides.mockup, at.packet, `${MOCKUP_ORIGIN}${shape.page}`);
    const drawn = await page.evaluate(drawMockup, { host: shape.host, call: shape.call });
    const left = drawn === '' ? undefined : await page.evaluate(marksOf, drawn);
    const right = await sides.gallery.evaluate(marksOf, shape.gallery);
    if (left !== undefined)
      writeFileSync(join(at.out, `mockup-${shape.what}${at.name}.png`), await picture(page, drawn));
    if (right !== undefined)
      writeFileSync(
        join(at.out, `gallery-${shape.what}${at.name}.png`),
        await picture(sides.gallery, shape.gallery),
      );
    lines.push(verdict(label, left, right));
    await page.close();
  }
  return lines;
}

const mockupDir = process.env['MOCKUP_DIR'];
if (mockupDir === undefined) throw new Error('visual: set MOCKUP_DIR to the pinned mockup clone');
const flag = process.argv.indexOf('--out');
const out =
  flag === -1 ? mkdtempSync(join(tmpdir(), 'charts-mockup-')) : (process.argv[flag + 1] ?? '');
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
      const gallerySide = await openSide(browser, packet, width, {
        app,
        session,
        colorScheme: theme,
      });
      try {
        const gallery = await load(gallerySide, packet, new URL('/gallery/', app).href);
        const name = `@${String(width)}-${theme}`;
        lines.push(...(await oneView({ mockup, gallery }, { packet, name, out })));
      } finally {
        await Promise.all([mockup.context.close(), gallerySide.context.close()]);
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
