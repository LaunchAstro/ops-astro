// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';

// Copied from Sol's review of #1820 (head 5ba5507). The first is bound to
// #1747's amendment (18 Oct): U14 and U18 move to #1819 and #1818.
import { ACCESS } from './owner-checks-access.ts';
import { FOUNDATION } from './owner-checks-foundation.ts';
import { SHELL } from './owner-checks-shell.ts';
import { launchChromium } from '../support/chromium.ts';

const at = { app: new URL('https://app.opsastro.com'), stamp: '5ba5507623c8' };

it('films every stage 1 unit the amended #1747 keeps', () => {
  const units = [...FOUNDATION, ...SHELL, ...ACCESS].flatMap((c) => c.unit.split(', '));
  expect(units).toEqual(
    expect.arrayContaining([
      'U01',
      'U02',
      'U03',
      'U04',
      'U06',
      'U07',
      'U08',
      'U10',
      'U11',
      'U12',
      'U17',
    ]),
  );
});

it('runs the U07 sign-out and sign-in in the browser', async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent('<main>Signed in to the deployed made-up business</main>');
    let actions = 0;
    const watched = new Proxy(page, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          actions++;
          return value.apply(target, args);
        };
      },
    });
    const step = SHELL.find((c) => c.unit === 'U07')!.steps.find(
      ([name]) => name === 'Both settings stick after signing out and in',
    )!;
    const outcome = await step[1](watched, at).then(
      () => 'ok',
      (error: Error) => error.message,
    );
    expect({ actions, outcome }).toMatchObject({ actions: expect.any(Number) });
    expect(actions, `U07 performed no browser actions: ${outcome}`).toBeGreaterThan(0);
  } finally {
    await browser.close();
  }
});
