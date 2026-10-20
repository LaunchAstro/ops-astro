// SPDX-License-Identifier: AGPL-3.0-only
//
// The interface package's stylesheets, joined in the order its entry imports
// them: what a page that loads the package is styled by. The tests that draw
// kit markup in Chromium, or read its cascade in jsdom, style it with these.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChromium } from '../support/chromium.ts';

const ui = join(import.meta.dirname, '../../packages/ui/src');

export const packageSheets = (): string =>
  [
    ...readFileSync(join(ui, 'index.ts'), 'utf8').matchAll(
      /^import '\.\/(styles\/[\w-]+\.css)';$/gmu,
    ),
  ]
    .map((match) => readFileSync(join(ui, match[1] ?? ''), 'utf8'))
    .join('\n');

/**
 * The columns each `.statrow` in `html` draws in Chromium under the package's
 * sheets, at each viewport width: the tracks its computed grid holds.
 */
export async function statColumnsDrawn(
  html: string,
  widths: readonly number[],
): Promise<Record<number, number[]>> {
  const browser = await launchChromium();
  try {
    const drawn = await Promise.all(
      widths.map(async (width) => {
        const tab = await browser.newPage({ viewport: { width, height: 800 } });
        await tab.setContent(`<style>${packageSheets()}</style>${html}`);
        return tab
          .locator('.statrow')
          .evaluateAll((rows) =>
            rows.map((row) => getComputedStyle(row).gridTemplateColumns.split(' ').length),
          );
      }),
    );
    return Object.fromEntries(widths.map((width, index) => [width, drawn[index] ?? []]));
  } finally {
    await browser.close();
  }
}
