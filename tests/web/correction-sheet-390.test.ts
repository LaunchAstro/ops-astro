// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- one theme at a time, in order. */
//
// #1695: the owner demos from his phone, so the correction cards are held at
// 390 in both themes, in a real browser on MP-1-7's width-and-theme harness.
// The Agent drawer opens as the bottom sheet; a waiting card's Launch and
// Decline and a published card's receipts sit inside the sheet and the
// window, nothing scrolls sideways, and the dark sheet paints differently from
// the light one. The made-up API answers no correction reads, so this test
// answers them: one waiting correction and one published with a receipt.
// #1781: the waiting card's single-operator line, and a Launch the server
// refused for a missing Astra review, held with its reason, fit there too.

import type { Page, Route } from 'playwright';
import { describe, expect, it } from 'vitest';
import { load } from '../visual/capture.ts';
import { scrollMetrics } from '../visual/drift.ts';
import { addressOf, overflowOf } from '../visual/report.ts';
import { onDockSides } from './dock-harness.ts';

const TAB = '.dock__tab[data-panel="ai"]';
const WIDTH = 390;

const item = (correctionId: string, state: string) => ({
  correctionId,
  taskId: '22222222-2222-4222-8222-222222222222',
  state,
  approver: state === 'requested' ? null : 'Grace Hopper',
  versionId: '11111111-1111-4111-8111-111111111111',
  pageUrl: 'https://agencyastro.com/about',
  word: 'alongside',
  replacement: 'beside',
  requestedAt: '2026-10-18T01:00:00.000Z',
});

const RECEIPT = {
  receiptId: 'r-1',
  step: 'publish',
  outcome: 'live',
  recordedAt: '2026-10-18T01:05:00.000Z',
  commit: '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567',
  deploymentId: 'dpl_7sodhsqcYJK3n1KNVuzCaJgczuWi',
  beforeCapture: { text: 'We work alongside the teams who run your website.', clipped: false },
  afterCapture: { text: 'We work beside the teams who run your website.', clipped: false },
};

/** The correction reads, answered here; every other call goes on to the harness. */
function correctionReads(route: Route): Promise<void> {
  const path = new URL(route.request().url()).pathname;
  if (path.endsWith('/live_correction/list')) {
    const corrections = [item('c-1', 'requested'), item('c-2', 'live')];
    return route.fulfill({ json: { ok: true, corrections } });
  }
  // The waiting card offers Launch once a read's check holds; the card reads it at 10 s.
  if (path.endsWith('/live_correction/read')) {
    const correction = { ...item('c-1', 'requested'), verifiedForMs: 600_000, refusal: null };
    return route.fulfill({ json: { ok: true, correction } });
  }
  if (path.endsWith('/live_correction/receipts')) {
    return route.fulfill({ json: { ok: true, correctionId: 'c-2', receipts: [RECEIPT] } });
  }
  return route.fallback();
}

/** The correction reads, the business in single-operator mode, and a Launch refused for review. */
function singleOperatorReads(route: Route): Promise<void> {
  const path = new URL(route.request().url()).pathname;
  if (path.endsWith('/settings/read')) {
    const row = { key: 'single_operator_mode', value: true, valueType: 'boolean', revision: 2 };
    return route.fulfill({ json: { ok: true, settings: [row] } });
  }
  if (path.endsWith('/live_correction/decide')) {
    const json = { refused: true, code: 'ASTRA_REVIEW_MISSING', names: [], fixes: [] };
    return route.fulfill({ status: 409, json });
  }
  return correctionReads(route);
}

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly height: number;
}

/** In the page: each named element's box, the sheet's box and the card's ground. */
function boxes(selectors: readonly string[]): {
  sheet: Box | null;
  found: Record<string, Box | null>;
  ground: string;
} {
  // Run in the page, so it keeps its helper inside.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const boxOf = (element: Element | null): Box | null => {
    if (element === null) return null;
    const { left, right, top, bottom, height } = element.getBoundingClientRect();
    return { left, right, top, bottom, height };
  };
  const found: Record<string, Box | null> = {};
  for (const selector of selectors) found[selector] = boxOf(document.querySelector(selector));
  const card = document.querySelector('[data-correction-card]');
  return {
    sheet: boxOf(document.querySelector('.dpanel')),
    found,
    ground: card === null ? '' : getComputedStyle(card).backgroundColor,
  };
}

const PARTS = [
  '[data-correction-state="requested"] [data-correction-decide="approve"]',
  '[data-correction-state="requested"] [data-correction-decide="reject"]',
  '[data-correction-receipts]',
];

const HELD_PARTS = [
  '[data-correction-state="requested"] [data-correction-single-operator]',
  '[data-correction-state="requested"] [data-correction-launch-held]',
  '[data-correction-state="requested"] [data-correction-decide="approve"]',
];

/** One line per part: inside the sheet and the window, tall enough to press; and the ground. */
async function measure(
  page: Page,
  parts: readonly string[] = PARTS,
): Promise<{ lines: string[]; ground: string }> {
  const lines: string[] = [];
  for (const selector of parts) {
    await page.locator(selector).scrollIntoViewIfNeeded();
    const { sheet, found } = await page.evaluate(boxes, parts);
    const box = found[selector] ?? null;
    const inside =
      box !== null &&
      sheet !== null &&
      // Whole pixels: layout lands on fractions of one.
      Math.round(box.left) >= Math.max(0, Math.round(sheet.left)) &&
      Math.round(box.right) <= Math.min(WIDTH, Math.round(sheet.right)) &&
      Math.round(box.top) >= Math.round(sheet.top) &&
      Math.round(box.bottom) <= Math.round(sheet.bottom);
    lines.push(
      `${selector}: ${inside ? 'inside' : 'outside'}, ${box !== null && box.height >= 24 ? 'pressable' : 'too small'}`,
    );
  }
  lines.push(`overflow ${String(overflowOf(await page.evaluate(scrollMetrics)))}`);
  const { ground } = await page.evaluate(boxes, parts);
  return { lines, ground };
}

describe('the correction cards at 390 in both themes', () => {
  it('Launch, Decline and a published card’s receipts sit inside the bottom sheet, light and dark', async () => {
    const seen: { theme: string; lines: string[]; ground: string; launch: string }[] = [];
    await onDockSides([WIDTH], ['light', 'dark'], async ({ side, packet, app, theme }) => {
      await side.context.route('**/api/b/**', correctionReads);
      const page = await load(
        side,
        packet,
        new URL(addressOf('agency:projects-board', { key: 'T-1' }) ?? '/', app).href,
      );
      try {
        await page.locator(TAB).click();
        await page.locator('[data-correction-card]').first().waitFor();
        await page.locator('[data-correction-receipts-open]').click();
        await page.locator('[data-correction-receipts]').waitFor();
        const launch =
          (await page.locator('[data-correction-decide="approve"]').textContent()) ?? '';
        seen.push({ theme, launch, ...(await measure(page)) });
      } finally {
        await page.close();
      }
    });
    const want = [...PARTS.map((part) => `${part}: inside, pressable`), 'overflow 0'];
    expect(seen.map(({ theme, lines }) => [theme, lines])).toStrictEqual([
      ['light', want],
      ['dark', want],
    ]);
    expect(seen.map((one) => one.launch)).toStrictEqual(['Launch', 'Launch']);
    expect(seen[0]?.ground).not.toBe(seen[1]?.ground);
  }, 300_000);
});

describe('the single-operator Launch control at 390 in both themes', () => {
  it('the single-operator line and a Launch held for Astra’s review sit inside the sheet, light and dark', async () => {
    const seen: { theme: string; lines: string[]; disabled: boolean }[] = [];
    await onDockSides([WIDTH], ['light', 'dark'], async ({ side, packet, app, theme }) => {
      await side.context.route('**/api/b/**', singleOperatorReads);
      const page = await load(
        side,
        packet,
        new URL(addressOf('agency:projects-board', { key: 'T-1' }) ?? '/', app).href,
      );
      try {
        await page.locator(TAB).click();
        await page.locator('[data-correction-single-operator]').waitFor();
        await page.locator('[data-correction-decide="approve"]').click();
        await page.locator('[data-correction-launch-held]').waitFor();
        const disabled = await page.locator('[data-correction-decide="approve"]').isDisabled();
        seen.push({ theme, disabled, ...(await measure(page, HELD_PARTS)) });
      } finally {
        await page.close();
      }
    });
    const want = [...HELD_PARTS.map((part) => `${part}: inside, pressable`), 'overflow 0'];
    expect(seen.map(({ theme, lines }) => [theme, lines])).toStrictEqual([
      ['light', want],
      ['dark', want],
    ]);
    expect(seen.map((one) => one.disabled)).toStrictEqual([true, true]);
  }, 300_000);
});
