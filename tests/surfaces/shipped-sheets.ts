// SPDX-License-Identifier: AGPL-3.0-only
//
// Markup drawn in Chromium under the UI package's sheets, all of them, in the
// order the package entry imports them, so a check reads what the product
// paints rather than one sheet on its own.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { launchChromium } from '../support/chromium.ts';

const ui = fileURLToPath(new URL('../../packages/ui/src/', import.meta.url));

/** Every sheet the package entry imports, in its order, as one text. */
export function shippedSheets(): string {
  return [
    ...readFileSync(`${ui}index.ts`, 'utf8').matchAll(/^import '\.\/(styles\/[\w-]+\.css)';$/gmu),
  ]
    .map((match) => readFileSync(`${ui}${match[1] ?? ''}`, 'utf8'))
    .join('\n');
}

export interface Drawing {
  readonly width?: number;
  readonly theme?: 'light' | 'dark';
  readonly forcedColors?: boolean;
}

/** `look` run on `html` drawn under the shipped sheets, then the browser closed. */
export async function drawn<T>(
  html: string,
  drawing: Drawing,
  look: (page: Page) => Promise<T>,
): Promise<T> {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage({ viewport: { width: drawing.width ?? 1280, height: 800 } });
    if (drawing.forcedColors === true) await page.emulateMedia({ forcedColors: 'active' });
    const theme = drawing.theme === 'dark' ? ' data-theme="dark"' : '';
    await page.setContent(
      `<!doctype html><html${theme}><head><style>${shippedSheets()}</style></head><body>${html}</body></html>`,
    );
    return await look(page);
  } finally {
    await browser.close();
  }
}
