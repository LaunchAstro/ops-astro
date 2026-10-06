// SPDX-License-Identifier: AGPL-3.0-only
//
// Mounted markup drawn in Chromium under the app's real cascade: the shared
// package's sheets in the order its `index.ts` imports them, then the app's
// own in the order `main.tsx` imports them (the load order main.tsx names as
// the contract). One computed property is read from each named element, and
// from each named value set on a probe in the page's body, so a token such as
// `var(--font-sans)` reads as the stack it stands for.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChromium } from '../support/chromium.ts';

const root = join(import.meta.dirname, '../..');
const sheetsOf = (entry: string, dir: string): string[] =>
  [
    ...readFileSync(join(root, entry), 'utf8').matchAll(/^import '\.\/(styles\/[\w-]+\.css)';$/gmu),
  ].map((match) => readFileSync(join(root, dir, match[1] ?? ''), 'utf8'));

const appSheets = (): string =>
  [
    ...sheetsOf('packages/ui/src/index.ts', 'packages/ui/src'),
    ...sheetsOf('apps/web/src/main.tsx', 'apps/web/src'),
  ].join('\n');

export async function drawnStyle(
  html: string,
  property: string,
  elements: Readonly<Record<string, string>>,
  values: Readonly<Record<string, string>> = {},
): Promise<Record<string, string | null>> {
  const browser = await launchChromium();
  try {
    const tab = await browser.newPage();
    await tab.setContent(`<style>${appSheets()}</style>${html}`);
    return await tab.evaluate(
      ([prop, named, set]) => {
        const read: Record<string, string | null> = {};
        for (const [name, selector] of Object.entries(named)) {
          const element = document.querySelector(selector);
          read[name] = element === null ? null : getComputedStyle(element).getPropertyValue(prop);
        }
        for (const [name, value] of Object.entries(set)) {
          const probe = document.createElement('span');
          probe.style.setProperty(prop, value);
          document.body.append(probe);
          read[name] = getComputedStyle(probe).getPropertyValue(prop);
          probe.remove();
        }
        return read;
      },
      [property, elements, values] as const,
    );
  } finally {
    await browser.close();
  }
}
