// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';

// The hidden-mark proof is copied from Sol's review of #1815 (head b4fcc15).
import { ACCESS } from './owner-checks-access.ts';
import { FOUNDATION } from './owner-checks-foundation.ts';
import { launchChromium } from '../support/chromium.ts';

const at = { app: new URL('https://app.opsastro.com'), stamp: 'b4fcc155697c' };

it('leaves U14 and U18 out of the pack until their screens exist (#1819, #1818)', () => {
  expect(ACCESS.map((one) => one.unit)).not.toContain('U14');
  expect(ACCESS.map((one) => one.unit)).not.toContain('U18');
});

it('refuses a chart whose only mark is hidden', async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<main><svg role="img" width="300" height="150"><rect style="visibility:hidden" width="300" height="150" fill="blue" /></svg><div role="tooltip">42</div></main>',
    );
    expect(await page.locator('rect').isVisible()).toBe(false);
    expect(
      await page.locator('rect').evaluate((node) => (node as SVGGraphicsElement).getBBox().width),
    ).toBe(300);
    await expect(
      FOUNDATION.find((one) => one.unit === 'U05')!.steps[0]![1](page, at),
    ).rejects.toThrow();
  } finally {
    await browser.close();
  }
});
