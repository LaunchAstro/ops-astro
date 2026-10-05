// SPDX-License-Identifier: AGPL-3.0-only
//
// Whether a term's tip shows, drawn in Chromium under the package's
// stylesheets in the order its entry imports them: at rest, under the
// pointer, once the pointer leaves, and when the keyboard brings focus to
// the term (`keyboard` says the focus is the keyboard's, `:focus-visible`).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChromium } from '../support/chromium.ts';

const ui = join(import.meta.dirname, '../../packages/ui/src');

const packageSheets = (): string =>
  [
    ...readFileSync(join(ui, 'index.ts'), 'utf8').matchAll(
      /^import '\.\/(styles\/[\w-]+\.css)';$/gmu,
    ),
  ]
    .map((match) => readFileSync(join(ui, match[1] ?? ''), 'utf8'))
    .join('\n');

export async function tipShown(html: string): Promise<Record<string, boolean>> {
  const browser = await launchChromium();
  try {
    const tab = await browser.newPage();
    await tab.setContent(`<style>${packageSheets()}</style>${html}`);
    const term = tab.locator('.term');
    const shown = () => tab.locator('.term__tip').isVisible();
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
