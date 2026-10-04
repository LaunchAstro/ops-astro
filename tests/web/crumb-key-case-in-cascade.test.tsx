// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { launchChromium } from '../support/chromium.ts';
import { found, page } from './task-page-stub.tsx';
import { unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

const root = join(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
// Keep the package's real stylesheet order, followed by the app's last sheet.
const sheets =
  [...read('packages/ui/src/index.ts').matchAll(/import '\.\/(styles\/[^']+\.css)'/gu)]
    .map((match) => read(`packages/ui/src/${match[1]}`))
    .join('\n') +
  '\n' +
  read('apps/web/src/styles/6-slice.css');

async function inBrowser(html: string, check: (page: import('playwright').Page) => Promise<void>) {
  const browser = await launchChromium({ headless: true });
  try {
    const tab = await browser.newPage();
    await tab.setContent(html);
    await tab.addStyleTag({ content: sheets });
    await check(tab);
  } finally {
    await browser.close();
  }
}

// Sol OW-130 criterion 7, retitled by what it proves; its body is Sol's.
it('the ID-case assertion misses the uppercase breadcrumb cascade', async () => {
  const view = await page('Proj-Verity-Pacing', found());
  // These are the existing test's complete stylesheet assertions; they pass.
  const rules = [
    ...read('packages/ui/src/styles/5-task.css').matchAll(/\.sbact__meta\s*\{([^}]*)\}/gu),
  ].map((match) => match[1]);
  expect(rules.length).toBeGreaterThan(0);
  for (const rule of rules) expect(rule).not.toMatch(/text-transform/u);
  try {
    await inBrowser(view.host.innerHTML, async (tab) => {
      expect(
        await tab
          .locator('[data-crumb="key"]')
          .evaluate((node) => getComputedStyle(node).textTransform),
      ).toBe('none');
    });
  } finally {
    await view.unmount();
  }
});
