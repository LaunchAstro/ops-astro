// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
/* oxlint-disable consistent-function-scoping, max-lines-per-function -- the functions handed
   to page.evaluate run in the browser and must carry their own helpers; one case per defect */
//
// REVIEW-2C1-24 to 27: red proofs against the board machine's stylesheet
// (packages/ui/src/styles/4b-board-machine.css), drawn on the made-up Projects
// board in a real browser, on the MP-5 board harness's setup
// (mp-5-board-harness.test.ts).
//
// 24: the Review chip's count is --accent-ink (near white) on the chip's
//     --surface (white in light): unreadable.
// 25: a focused comment badge turns its ground to --ink, which in dark is the
//     badge's own --accent-ink: the number vanishes.
// 26: the sticky chip row (z-index 12) lies over the search typeahead
//     (z-index 5): the first option cannot be pressed.
// 27: an open cell editor turns the table's scrolling wrap to overflow
//     visible: at 390 the scrolled table spills and the page scrolls sideways.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchChromium } from '../support/chromium.ts';
import { madeUpSession, screenOf, serveApp } from './app-pages.ts';
import { load, openSide } from './capture.ts';
import { answerMadeUp, madeUpAnswer, TASKS } from './made-up-api.ts';
import { fetchAssets, MODE, readAssets, readPacket, type Packet } from './packet.ts';

let browser: Browser;
let packet: Packet;
let served: Awaited<ReturnType<typeof serveApp>>;
let session: string;
const out = mkdtempSync(join(tmpdir(), 'review-2c1-24-'));

beforeAll(async () => {
  packet = readPacket();
  await fetchAssets(readAssets(), packet);
  browser = await launchChromium(MODE);
  served = await serveApp();
  session = madeUpSession(served.app, out);
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await served?.close();
  rmSync(out, { recursive: true, force: true });
});

/** The Projects board at one width and theme, its rows drawn; the callback reads it. */
async function onBoard<T>(
  width: number,
  theme: 'light' | 'dark',
  read: (page: Page) => Promise<T>,
  answers: { comments?: boolean } = {},
): Promise<T> {
  const side = await openSide(browser, packet, width, {
    app: served.app,
    session,
    colorScheme: theme,
  });
  await answerMadeUp(side.context);
  // The made-up rows wait on no comments; for 25 the first row waits on three,
  // so its badge draws. Routed last, so asked first.
  if (answers.comments === true) {
    await side.context.route('**/api/b/*/task/board', async (route) => {
      const base = madeUpAnswer(new URL(route.request().url()).pathname);
      const waiting = { client: 2, mentions: 1, latest: '2026-09-25T04:00:00.000Z' };
      const [first, ...rest] = TASKS;
      const tasks = first === undefined ? [] : [{ ...first, comments: waiting }, ...rest];
      await route.fulfill({
        status: 200,
        json: { ...(base?.json as Record<string, unknown>), tasks },
      });
    });
  }
  try {
    const page = await load(side, packet, new URL('/projects/', served.app).href);
    await page.locator('tbody tr[data-row]').first().waitFor();
    expect(await page.evaluate(screenOf)).toBe('the page');
    return await read(page);
  } finally {
    await side.context.close();
  }
}

/**
 * The WCAG contrast of an element's text colour against the ground it is drawn
 * on (its own background, composited over its ancestors' until opaque), or of
 * two named colours. Colours are resolved by the browser (a canvas pixel), so
 * oklch and color-mix read as drawn.
 */
function contrastIn(selector: string): { text: string; ground: string; ratio: number } {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new Error('no 2d canvas');
  const rgba = (color: string): [number, number, number, number] => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const el = document.querySelector(selector);
  if (el === null) throw new Error(`${selector} is not on the page`);
  // The ground: backgrounds from the element up, composited until opaque, over white.
  const layers: [number, number, number, number][] = [];
  for (let at: Element | null = el; at !== null; at = at.parentElement) {
    const one = rgba(getComputedStyle(at).backgroundColor);
    if (one[3] > 0) layers.push(one);
    if (one[3] >= 1) break;
  }
  let ground: [number, number, number] = [255, 255, 255];
  for (const [r, g, b, a] of layers.toReversed()) {
    ground = [
      r * a + ground[0] * (1 - a),
      g * a + ground[1] * (1 - a),
      b * a + ground[2] * (1 - a),
    ];
  }
  const [tr, tg, tb, ta] = rgba(getComputedStyle(el).color);
  const text: [number, number, number] = [
    tr * ta + ground[0] * (1 - ta),
    tg * ta + ground[1] * (1 - ta),
    tb * ta + ground[2] * (1 - ta),
  ];
  const lum = ([r, g, b]: [number, number, number]): number => {
    const lin = (c: number): number => {
      const s = c / 255;
      return s <= 0.039_28 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const [hi, lo] = [lum(text), lum(ground)].toSorted((x, y) => y - x);
  const ratio = ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
  const css = (c: [number, number, number]): string =>
    `rgb(${c.map((v) => Math.round(v)).join(',')})`;
  return { text: css(text), ground: css(ground), ratio: Math.round(ratio * 100) / 100 };
}

describe('REVIEW-2C1-24 to 27: the board machine stylesheet (4b-board-machine.css)', () => {
  it('REVIEW-2C1-24: the Review chip count is --accent-ink (near white) on the chip surface (white) in light, below 4.5:1', async () => {
    const seen = await onBoard(1480, 'light', async (page) => {
      const count = page.locator('[data-mode="review"] .cbd__count').filter({ visible: true });
      expect(await count.count(), 'the Review chip draws a count').toBeGreaterThan(0);
      return page.evaluate(contrastIn, '[data-mode="review"] .cbd__count');
    });
    expect(
      seen.ratio,
      `light Review count ${seen.text} on ${seen.ground}: contrast ${String(seen.ratio)}`,
    ).toBeGreaterThanOrEqual(4.5);
  }, 120_000);

  it('REVIEW-2C1-25: a focused comment badge in dark draws its number --accent-ink on --ink (both 0.98), below 4.5:1', async () => {
    const seen = await onBoard(
      1480,
      'dark',
      async (page) => {
        const badge = page.locator('.cbd__cmt').filter({ visible: true }).first();
        expect(await badge.count(), 'a row draws a comment badge').toBeGreaterThan(0);
        // Keyboard focus, as a person tabbing reaches it, so :focus-visible holds.
        await page.keyboard.press('Shift');
        await badge.focus();
        const focused = await badge.evaluate((el) => el.matches(':focus-visible'));
        expect(focused, 'the comment badge holds :focus-visible').toBe(true);
        await badge.evaluate((el) => {
          el.dataset['reviewProof'] = '25';
        });
        // The focus style is read once it has settled: a frame for the style, then
        // any transition it starts run to its end.
        await page.evaluate(async () => {
          await new Promise((frame) => {
            requestAnimationFrame(frame);
          });
          await Promise.all(document.getAnimations().map((a) => a.finished));
        });
        return page.evaluate(contrastIn, '[data-review-proof="25"] .cbd__cmtn');
      },
      { comments: true },
    );
    expect(seen.text, 'focused badge number differs from its ground').not.toBe(seen.ground);
    expect(
      seen.ratio,
      `dark focused comment count ${seen.text} on ${seen.ground}: contrast ${String(seen.ratio)}`,
    ).toBeGreaterThanOrEqual(4.5);
  }, 120_000);

  it('REVIEW-2C1-26: at 1280 the sticky chip row (z-index 12) covers the search typeahead (z-index 5), so its first option is not the element at its centre', async () => {
    const seen = await onBoard(1280, 'light', async (page) => {
      await page.locator('[data-board-search]').first().fill('re');
      const option = page.locator('.cbdta__opt').first();
      await option.waitFor();
      return option.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        const name = (node: Element | null): string =>
          node === null
            ? 'nothing'
            : `${node.tagName.toLowerCase()}.${[...node.classList].join('.')}` +
              (node.closest('.cbd__filters') === null ? '' : ' (in .cbd__filters)');
        return { hits: hit !== null && el.contains(hit), what: name(hit) };
      });
    });
    expect(seen.hits, `the first typeahead option's centre hits ${seen.what}, not the option`).toBe(
      true,
    );
  }, 120_000);

  it('REVIEW-2C1-27: at 390 the Due editor opened in a scrolled table lifts the wrap to overflow visible, so the page scrolls sideways and the editor leaves the viewport', async () => {
    const seen = await onBoard(390, 'light', async (page) => {
      const wrap = page.locator('.cbd__wrap').first();
      await wrap.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      const scrolled = await wrap.evaluate((el) => el.scrollLeft);
      expect(scrolled, 'the table wrap scrolls right at 390').toBeGreaterThan(0);
      const due = page.locator('td[data-key="due"] .cbd__edb').filter({ visible: true }).first();
      expect(await due.count(), 'a row draws an editable Due cell').toBeGreaterThan(0);
      await due.click();
      const editor = page.locator('.cbd__ed').first();
      await editor.waitFor();
      return editor.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const scroller = document.scrollingElement ?? document.documentElement;
        return {
          left: Math.round(box.left),
          right: Math.round(box.right),
          inner: window.innerWidth,
          scrollWidth: scroller.scrollWidth,
        };
      });
    });
    expect(
      seen.scrollWidth,
      `with the Due editor open the page is ${String(seen.scrollWidth)}px wide at ${String(seen.inner)}`,
    ).toBeLessThanOrEqual(seen.inner);
    expect(
      seen.left >= 0 && seen.right <= seen.inner,
      `the Due editor spans ${String(seen.left)} to ${String(seen.right)}, outside 0 to ${String(seen.inner)}`,
    ).toBe(true);
  }, 120_000);
});
