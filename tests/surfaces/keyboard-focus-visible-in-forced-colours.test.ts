// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
//
// Keyboard focus stays visible when the system forces its own colours (Windows
// high contrast). Forced colours drop every box shadow, so the focus ring
// alone would vanish; an outline is painted in the system's colour instead. In
// normal colours the ring is the box shadow and nothing else shows.

import { expect, it } from 'vitest';
import { drawn } from './shipped-sheets.ts';

const BUTTON = '<button class="btn btn--primary btn--sm" type="button">Save</button>';

/** The focused button's outline and shadow, reached by Tab. */
const focusOf = (forcedColors: boolean) =>
  drawn(BUTTON, { forcedColors }, async (page) => {
    await page.keyboard.press('Tab');
    return page.evaluate(() => {
      const button = document.activeElement;
      if (!(button instanceof HTMLButtonElement) || !button.matches(':focus-visible')) return null;
      const style = getComputedStyle(button);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: Number(style.outlineWidth.replace(/px$/u, '')),
        outlineColor: style.outlineColor,
        boxShadow: style.boxShadow,
      };
    });
  });

it('keyboard focus on a button keeps a visible outline in forced colours', async () => {
  const seen = await focusOf(true);
  expect(seen).not.toBeNull();
  expect(seen?.outlineStyle).not.toBe('none');
  expect(seen?.outlineWidth).toBeGreaterThan(0);
  expect(seen?.outlineColor).not.toBe('rgba(0, 0, 0, 0)');
}, 30_000);

it('in normal colours the focus ring is the shadow and the outline paints nothing', async () => {
  const seen = await focusOf(false);
  expect(seen).not.toBeNull();
  expect(seen?.boxShadow).not.toBe('none');
  expect(seen?.outlineStyle === 'none' || seen?.outlineColor === 'rgba(0, 0, 0, 0)').toBe(true);
}, 30_000);
