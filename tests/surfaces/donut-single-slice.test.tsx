// SPDX-License-Identifier: AGPL-3.0-only
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { DonutChart } from '../../packages/ui/src/kit/chart-radial.tsx';
import { launchChromium } from '../support/chromium.ts';

// Sol OW-104.4 correctness, retitled by what it proves; its body is Sol's.
it('a single-slice donut retains a hole and a filled ring', async () => {
  const endpoint = process.env['OW104_BROWSER_WS'];
  const browser =
    endpoint === undefined
      ? await launchChromium({ headless: true })
      : await chromium.connect(endpoint);
  try {
    const page = await browser.newPage();
    await page.setContent(
      renderToStaticMarkup(
        <DonutChart
          name="Sources"
          centre="10"
          centreLabel="Enquiries"
          slices={[{ label: 'Search', value: 10 }]}
        />,
      ),
    );
    const geometry = await page.evaluate(() => {
      const path = document.querySelector('.chart__slice');
      if (!(path instanceof SVGGeometryElement)) throw new Error('missing slice');
      return {
        holeFilled: path.isPointInFill(new DOMPoint(75, 75)),
        ringFilled: path.isPointInFill(new DOMPoint(135, 75)),
      };
    });
    expect(geometry.ringFilled).toBe(true);
    expect(geometry.holeFilled).toBe(false);
  } finally {
    await browser.close();
  }
});
