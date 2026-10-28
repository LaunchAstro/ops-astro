// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X, LF-2, in a real browser: the product, the review's site and a
// hostile second origin (the world beside this file). Pages that relay or
// forge a hello mark that they sent it, so each refusal is a refusal of a
// message that really arrived.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HOSTILE,
  LINE,
  PRODUCT,
  SITE,
  expectNoCanary,
  frameAt,
  open,
  phase,
  sent,
  startWorld,
  stopWorld,
} from './c35-x-live-view-world.ts';

beforeAll(startWorld);
afterAll(stopWorld);

describe('C35-X the live view shows only after hello from the expected origin within 3 seconds', () => {
  it('the embed says hello and the frame shows beside the capture', async () => {
    const watched = await open({ page: `${SITE}/embed` });
    try {
      await watched.page.waitForSelector('[data-live-view="live"]', { timeout: 3000 });
      expect(await watched.page.locator('[data-live-frame]').isVisible()).toBe(true);
      expect(await watched.page.locator('[data-live-capture] img').count()).toBe(1);
      expect(await watched.page.getByText(LINE).count()).toBe(0);
    } finally {
      await watched.context.close();
    }
  }, 30_000);

  it('a new revision is a new load with a new nonce, and the old frame is gone', async () => {
    const watched = await open({ page: `${SITE}/embed` });
    try {
      await watched.page.waitForSelector('[data-live-view="live"]', { timeout: 3000 });
      const first = await frameAt(watched.page, '/embed').evaluate(
        () => document.body.dataset['nonce'],
      );
      await watched.page.click('[data-next-revision]');
      await watched.page.waitForSelector('[data-live-view="live"]', { timeout: 3000 });
      expect(await watched.page.locator('iframe[data-live-frame]').count()).toBe(1);
      const second = await frameAt(watched.page, '/embed').evaluate(
        () => document.body.dataset['nonce'],
      );
      expect(first).toMatch(/^[\w-]{43}$/u);
      expect(second).toMatch(/^[\w-]{43}$/u);
      expect(second).not.toBe(first);
      await watched.page.click('[data-unmount]');
      expect(await watched.page.locator('iframe').count()).toBe(0);
    } finally {
      await watched.context.close();
    }
  }, 30_000);
});

describe('C35-X otherwise the capture shows with the line', () => {
  it('a site with no embed waits 3 seconds, then shows the capture, the line and the staged page', async () => {
    const watched = await open({ page: `${SITE}/bare` });
    try {
      await watched.page.waitForTimeout(2500);
      expect(await phase(watched.page)).toBe('waiting');
      await watched.page.waitForSelector('[data-live-view="fallback"]', { timeout: 2000 });
      expect(await watched.page.getByText(LINE).count()).toBe(1);
      expect(await watched.page.locator('[data-live-capture] img').count()).toBe(1);
      const link = watched.page.locator('a[data-staged-page]');
      expect(await link.getAttribute('href')).toBe(`${SITE}/bare`);
      expect(await link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(await watched.page.locator('iframe').count()).toBe(0);
    } finally {
      await watched.context.close();
    }
  }, 30_000);

  it('a site that refuses framing falls back the same way', async () => {
    const watched = await open({ page: `${SITE}/refused` });
    try {
      await watched.page.waitForSelector('[data-live-view="fallback"]', { timeout: 4500 });
      expect(await watched.page.getByText(LINE).count()).toBe(1);
    } finally {
      await watched.context.close();
    }
  }, 30_000);

  it('a hello after 3 seconds, right frame and nonce, opens nothing', async () => {
    const watched = await open({ page: `${SITE}/late` });
    try {
      await watched.page.waitForTimeout(4500);
      expect(await phase(watched.page)).toBe('fallback');
      expect(await watched.page.locator('iframe').count()).toBe(0);
    } finally {
      await watched.context.close();
    }
  }, 30_000);
});

describe('C35-X the framed address', () => {
  it.each(['http://site.test/embed', `https://u:p${'@'}site.test/embed`, `${PRODUCT}/x`])(
    'an address that is not the bound https page frames nothing and shows the line at once (%s)',
    async (address) => {
      const watched = await open({ page: address });
      try {
        expect(await phase(watched.page)).toBe('fallback');
        expect(await watched.page.locator('iframe').count()).toBe(0);
        expect(await watched.page.locator('a[data-staged-page]').count()).toBe(0);
      } finally {
        await watched.context.close();
      }
    },
    30_000,
  );
});

describe('C35-X no capture backend still shows the live view or the line', () => {
  it('with no capture, the live view still opens beside an honest unavailable state', async () => {
    const watched = await open({ page: `${SITE}/embed`, capture: '0' });
    try {
      await watched.page.waitForSelector('[data-live-view="live"]', { timeout: 3000 });
      expect(await watched.page.locator('[data-live-capture]').innerText()).toContain(
        'No capture yet',
      );
    } finally {
      await watched.context.close();
    }
  }, 30_000);

  it('with no capture and no embed, the line still shows', async () => {
    const watched = await open({ page: `${SITE}/bare`, capture: '0' });
    try {
      await watched.page.waitForSelector('[data-live-view="fallback"]', { timeout: 4500 });
      expect(await watched.page.getByText(LINE).count()).toBe(1);
      expect(await watched.page.locator('[data-live-capture]').innerText()).toContain(
        'No capture yet',
      );
    } finally {
      await watched.context.close();
    }
  }, 30_000);
});

describe('C35-X a message from any other origin is ignored', () => {
  it('a hostile origin echoing the right nonce to the product opens nothing', async () => {
    const watched = await open({ page: `${SITE}/origin-forger` });
    try {
      await expect.poll(async () => await sent(frameAt(watched.page, '/forge', HOSTILE))).toBe('1');
      expect(await phase(watched.page)).toBe('waiting');
      await watched.page.waitForSelector('[data-live-view="fallback"]', { timeout: 4500 });
    } finally {
      await watched.context.close();
    }
  }, 30_000);
});

describe('C35-X sibling frame', () => {
  it("a same-origin sibling's hello with the right nonce opens nothing", async () => {
    const watched = await open({ page: `${SITE}/relay`, sibling: `${SITE}/sibling` });
    try {
      await expect.poll(async () => await sent(frameAt(watched.page, '/sibling'))).toBe('1');
      expect(await phase(watched.page)).toBe('waiting');
      await watched.page.waitForSelector('[data-live-view="fallback"]', { timeout: 4500 });
    } finally {
      await watched.context.close();
    }
  }, 30_000);
});

describe('C35-X a malformed or foreign postMessage is ignored', () => {
  it('malformed hellos from the selected frame open nothing and throw nothing', async () => {
    const watched = await open({ page: `${SITE}/malformed` });
    try {
      await expect.poll(async () => await sent(frameAt(watched.page, '/malformed'))).toBe('1');
      expect(await phase(watched.page)).toBe('waiting');
      await watched.page.waitForSelector('[data-live-view="fallback"]', { timeout: 4500 });
      expect(watched.productErred).toEqual([]);
    } finally {
      await watched.context.close();
    }
  }, 30_000);
});

describe('C35-X frame attributes', () => {
  it('sandbox is exactly scripts and same origin; allow denies camera, microphone, location and payment', async () => {
    const watched = await open({ page: `${SITE}/embed` });
    try {
      const frame = watched.page.locator('iframe[data-live-frame]');
      expect(await frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
      expect(await frame.getAttribute('allow')).toBe(
        "camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'",
      );
      expect(await frame.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(await frame.getAttribute('src')).toBe(`${SITE}/embed`);
    } finally {
      await watched.context.close();
    }
  }, 30_000);
});

describe('C35-X hostile frame', () => {
  it('top navigation, a popup, a download, the capabilities and a forged message each fail', async () => {
    const watched = await open({ page: `${HOSTILE}/attack` });
    try {
      await watched.page.waitForSelector('[data-live-view="live"]', { timeout: 3000 });
      const attack = frameAt(watched.page, '/attack', HOSTILE);
      await expect
        .poll(async () => await attack.evaluate(() => document.body.dataset['result']))
        .toBeTruthy();
      const result = JSON.parse(
        (await attack.evaluate(() => document.body.dataset['result'])) ?? '{}',
      ) as Record<string, unknown>;
      await watched.page.waitForTimeout(500);
      expect(watched.page.url()).toContain(`${PRODUCT}/tests/browser/c35-x-live-view.html`);
      expect(result['popup']).not.toBe('opened');
      expect(watched.popups).toEqual([]);
      expect(watched.downloads).toEqual([]);
      for (const feature of ['camera', 'microphone', 'geolocation', 'payment']) {
        expect(result[feature], feature).toBe(false);
      }
      expect(await phase(watched.page)).toBe('live');
      expect(watched.productErred).toEqual([]);
    } finally {
      await watched.context.close();
    }
  }, 30_000);
});

describe('C35-X canary', () => {
  it.each(['/embed', '/bare', '/malformed'])(
    'framed content and payloads never reach the product console, errors, requests or text (%s)',
    async (path) => {
      const watched = await open({ page: `${SITE}${path}` });
      try {
        await watched.page.waitForSelector('[data-live-view="live"], [data-live-view="fallback"]', {
          timeout: 4500,
        });
        expectNoCanary(watched, await watched.page.locator('body').innerText());
      } finally {
        await watched.context.close();
      }
    },
    30_000,
  );

  it('a hostile page that goes live leaks nothing into the product either', async () => {
    const watched = await open({ page: `${HOSTILE}/attack` });
    try {
      await watched.page.waitForSelector('[data-live-view="live"]', { timeout: 3000 });
      await watched.page.waitForTimeout(1500);
      expectNoCanary(watched, await watched.page.locator('body').innerText());
    } finally {
      await watched.context.close();
    }
  }, 30_000);
});

describe('C35-X the product never fetches or proxies a client page', () => {
  it('only the frame itself asks the site for its page', async () => {
    const watched = await open({ page: `${SITE}/embed` });
    try {
      await watched.page.waitForSelector('[data-live-view="live"]', { timeout: 3000 });
      for (const asked of watched.productAsked) expect(new URL(asked).origin).toBe(PRODUCT);
      // Only the product page's own address names the site: nothing fetches it.
      expect(watched.productAsked.filter((asked) => asked.includes('site.test'))).toEqual([
        watched.page.url(),
      ]);
    } finally {
      await watched.context.close();
    }
  }, 30_000);
});
