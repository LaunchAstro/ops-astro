// SPDX-License-Identifier: AGPL-3.0-only
//
// Whether a term's tip shows, drawn in Chromium under the package's
// stylesheets in the order its entry imports them: at rest, under the
// pointer, once the pointer leaves, and when the keyboard brings focus to
// the term (`keyboard` says the focus is the keyboard's, `:focus-visible`).
// A tip counts as shown only when it paints, so a transparent or covered tip
// is not.

import { launchChromium } from '../support/chromium.ts';
import { packageSheets } from './kit-drawn.ts';

export async function tipShown(html: string): Promise<Record<string, boolean>> {
  const browser = await launchChromium();
  try {
    const tab = await browser.newPage();
    await tab.setContent(`<style>${packageSheets()}</style>${html}`);
    const term = tab.locator('.term');
    // Shown means painted: a box with size, visible, every ancestor's opacity
    // above zero, and the tip itself on top at its own centre.
    const shown = () =>
      tab.locator('.term__tip').evaluate((tip) => {
        const box = tip.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        if (getComputedStyle(tip).visibility !== 'visible') return false;
        for (let node: Element | null = tip; node !== null; node = node.parentElement) {
          if (Number(getComputedStyle(node).opacity) === 0) return false;
        }
        const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return top !== null && tip.contains(top);
      });
    const rest = await shown();
    await term.hover();
    const hover = await shown();
    await tab.mouse.move(0, 0);
    const left = await shown();
    await tab.keyboard.press('Tab');
    const keyboard = await term.evaluate((node) => node.matches(':focus-visible'));
    return { rest, hover, left, keyboard, focus: await shown() };
  } finally {
    await browser.close();
  }
}
