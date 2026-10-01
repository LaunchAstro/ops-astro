// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- widths, themes and rail widths run one at
   a time, in order, so each reading and picture comes in a fixed order. */
//
// The rail's fold, motion and folded strip in a real browser (MP-2-3; SIDEBAR
// DS-SIDE-11, 12, 15, T-R2 to T-R4), on MP-1-7's width-and-theme harness: the
// app served from source, the made-up session, 1480, 900 and 390 in light and
// dark. No browser fails the test; it never skips.
//
// This is MP-2-3's visual-match leg on the served app (ruling 2026-09-29
// 12:15:30Z, ORCH47 (b)9). The app has no /dashboard/ page yet and draws the
// same rail on every page, so the rail is read on the Projects board. The
// mockup half runs where the mockup is: `tests/visual/look/rail.ts` holds the
// rail to the mockup's /dashboard/ values pinned by `look.ts --measure` in the
// pinned renderer, and the pictures and readings beside the mockup inventory's
// captures (SHELL `dashboard--rail-collapsed`) are kept in the roadmap at
// `.local/design-system-2026-09-26/evidence/SL06-rail-mockup-match/`.

import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { load } from '../visual/capture.ts';
import { comparePng } from '../visual/compare.ts';
import { addressOf } from '../visual/report.ts';
import { onDockSides, type DockSide } from './dock-harness.ts';

type Box = { x: number; y: number; width: number; height: number };

const BOARD = addressOf('agency:projects-board', { key: 'T-1' }) ?? '/';
const FOLD = '.railfold';
const WORDMARK = '.rail__brand .brand';

function open(at: DockSide): Promise<Page> {
  return load(at.side, at.packet, new URL(BOARD, at.app).href);
}

/** Every transition under way has landed. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((each) => each instanceof CSSTransition)
        .map((each) => each.finished.catch(() => each)),
    ),
  );
}

async function boxOf(page: Page, selector: string): Promise<Box> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`rail-look: ${selector} draws no box`);
  return box;
}

/** The air between two boxes: negative where they overlap. */
function air(a: Box, b: Box): number {
  return Math.max(
    b.x - (a.x + a.width),
    a.x - (b.x + b.width),
    b.y - (a.y + a.height),
    a.y - (b.y + b.height),
  );
}

/** Notes what the shell carries the moment it is first in the document, before any layout. */
async function watchFirstLayout(at: DockSide): Promise<void> {
  await at.side.context.addInitScript(() => {
    new MutationObserver((_, watch) => {
      const shell = document.querySelector<HTMLElement>('.shell');
      if (shell === null) return;
      watch.disconnect();
      document.documentElement.dataset['railFirst'] = JSON.stringify({
        ready: Object.hasOwn(shell.dataset, 'dockReady'),
        duration: getComputedStyle(shell).transitionDuration,
      });
    }).observe(document, { childList: true, subtree: true });
  });
}

describe('MP-2-3 the collapse moves the shell, not an overlay', () => {
  it("sweeps the shell's grid columns over 420 ms with --ease, and nothing animates before the first layout", async () => {
    await onDockSides([1480], ['light'], async (at) => {
      await watchFirstLayout(at);
      // The harness asks for reduced motion; this reading is of the motion itself.
      const page = await at.side.context.newPage();
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.goto(new URL(BOARD, at.app).href, { waitUntil: 'load' });
      await page.waitForSelector('.shell');
      const first = await page.evaluate(() => document.documentElement.dataset['railFirst']);
      expect(JSON.parse(first ?? '{}')).toStrictEqual({ ready: false, duration: '0s' });
      await page.waitForSelector('.shell[data-dock-ready]');
      const main = await boxOf(page, 'main.main');
      await page.locator(FOLD).click();
      const sweep = await page.evaluate(() => {
        const shell = document.querySelector('.shell');
        const ease = getComputedStyle(document.documentElement).getPropertyValue('--ease');
        return {
          ease: ease.trim(),
          running: document
            .getAnimations()
            .filter((each) => each instanceof CSSTransition)
            .filter((each) => (each.effect as KeyframeEffect | null)?.target === shell)
            .map((each) => ({
              property: each.transitionProperty,
              duration: each.effect?.getTiming().duration,
              easing: each.effect?.getTiming().easing,
            })),
        };
      });
      expect(sweep.ease).not.toBe('');
      expect(sweep.running).toStrictEqual([
        { property: 'grid-template-columns', duration: 420, easing: sweep.ease },
      ]);
      await settle(page);
      expect((await boxOf(page, 'nav.rail')).width).toBe(56);
      expect(main.x - (await boxOf(page, 'main.main')).x).toBe(168);
    });
  }, 300_000);
});

describe('MP-2-3 the fold button sits clear of the wordmark (DR-61)', () => {
  it('leaves air between the fold and the wordmark and its label at every rail width, and above the folded mark', async () => {
    await onDockSides([1480], ['light'], async (at) => {
      const page = await open(at);
      const grip = page.locator('.railgrip');
      // Home is the rail's 224; the keys step 16, or 64 with shift, held to 170 and 400.
      const widths: [number, string[]][] = [
        [224, ['Home']],
        [170, ['Shift+ArrowLeft']],
        [320, ['Home', 'Shift+ArrowRight', 'ArrowRight', 'ArrowRight']],
        [400, ['Shift+ArrowRight', 'Shift+ArrowRight']],
      ];
      for (const [width, keys] of widths) {
        for (const key of keys) await grip.press(key);
        await settle(page);
        const rail = await boxOf(page, 'nav.rail');
        expect(rail.width).toBe(width);
        const fold = await boxOf(page, FOLD);
        expect(air(fold, await boxOf(page, WORDMARK)), `wordmark at ${width}`).toBeGreaterThan(1);
        expect(air(fold, await boxOf(page, '.rail__hub')), `label at ${width}`).toBeGreaterThan(1);
        expect(fold.x + fold.width, `inside the rail at ${width}`).toBeLessThan(width - 1);
      }
      await page.locator(FOLD).click();
      await settle(page);
      expect(air(await boxOf(page, FOLD), await boxOf(page, WORDMARK))).toBeGreaterThan(1);
    });
  }, 300_000);
});

/** Each section: its 16 px glyph when folded, its label in the drawer. */
async function expectSections(page: Page, name: string, folded: boolean): Promise<void> {
  const items = await page.locator('.rail__group .rail__item').all();
  expect(items.length, name).toBeGreaterThan(0);
  for (const item of items) {
    const label = (await item.locator('.rail__label').textContent()) ?? '';
    const icon = item.locator('.rail__icon');
    expect(await item.locator('.rail__glyph').count(), `${name} ${label}`).toBe(0);
    // Folded, the glyph is what shows and the label is clipped to one
    // pixel; in the drawer, the label is what shows.
    expect(await icon.isVisible(), `${name} ${label}`).toBe(folded);
    const words = await item.locator('.rail__label').boundingBox();
    expect((words?.width ?? 0) > 1, `${name} ${label}`).toBe(!folded);
    if (folded) {
      const box = await icon.boundingBox();
      expect([box?.width, box?.height], `${name} ${label}`).toStrictEqual([16, 16]);
    }
    // The label stays the link's accessible name, drawn or not.
    const named = page.locator('nav.rail').getByRole('link', { name: label, exact: true });
    await expect.poll(() => named.count(), { message: `${name} ${label}` }).toBe(1);
  }
}

describe('MP-2-3 the folded strip, and the drawer at 900 and below', () => {
  it('draws each section as its 16 px glyph named by its label at 1480, the drawer as labels at 900 and 390, light and dark', async () => {
    const pictures = new Map<string, Buffer>();
    await onDockSides([1480, 900, 390], ['light', 'dark'], async (at) => {
      const page = await open(at);
      const name = `rail@${String(at.width)}-${at.theme}`;
      if (at.width > 900) {
        await page.locator(FOLD).click();
        await settle(page);
        expect((await boxOf(page, 'nav.rail')).width, name).toBe(56);
        // The planet mark in place of the wordmark, 24 wide (DS-SIDE-12).
        expect((await boxOf(page, WORDMARK)).width, name).toBe(24);
      } else {
        await expect(page.locator(FOLD).isVisible(), name).resolves.toBe(false);
        await expect(page.locator('.railgrip').isVisible(), name).resolves.toBe(false);
        await page.locator('.navtoggle').click();
        await page.locator('nav.rail[role="dialog"]').waitFor({ state: 'visible' });
        await settle(page);
        expect((await boxOf(page, 'nav.rail')).width, name).toBe(Math.min(300, at.width * 0.84));
      }
      await expectSections(page, name, at.width > 900);
      await page.mouse.move(700, 600);
      pictures.set(name, await page.locator('nav.rail').screenshot({ animations: 'disabled' }));
    });
    for (const width of [1480, 900, 390]) {
      const light = pictures.get(`rail@${String(width)}-light`) ?? Buffer.alloc(0);
      const dark = pictures.get(`rail@${String(width)}-dark`) ?? Buffer.alloc(0);
      expect(light.length, `${String(width)} light`).toBeGreaterThan(0);
      const same = comparePng(`rail@${String(width)}`, light, dark);
      expect(same.pass, `${String(width)}: dark draws the rail as light does`).toBe(false);
    }
  }, 600_000);
});
