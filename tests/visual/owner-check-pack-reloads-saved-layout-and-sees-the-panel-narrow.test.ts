// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-await-in-loop -- each step runs on the one page, one after the other */
import { expect, it } from 'vitest';

// Copied from Sol's review of #1823 (head ae5a555). The first is bound to
// #1747's amendment, which moves U05 to #1822.
import { FOUNDATION } from './owner-checks-foundation.ts';
import { SHELL } from './owner-checks-shell.ts';
import { ACCESS } from './owner-checks-access.ts';
import { launchChromium } from '../support/chromium.ts';

const at = { app: new URL('https://app.opsastro.com'), stamp: 'ae5a5558df57' };

it('leaves U05 to #1822, as the amended #1747 says', () => {
  expect([...FOUNDATION, ...SHELL, ...ACCESS].flatMap((c) => c.unit.split(', '))).not.toContain(
    'U05',
  );
});

it('reloads to check the saved panel width and rail', async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    const selected = [
      SHELL.find((c) => c.unit === 'U08, U12')!.steps.find(
        ([name]) => name === 'The panel width is kept next time',
      )!,
      ACCESS.find((c) => c.unit === 'U17')!.steps.find(
        ([name]) => name === 'Both kept after a reload',
      )!,
    ];
    for (const [name, act] of selected) {
      let calls = 0;
      const watched = new Proxy(page, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            calls++;
            return value.apply(target, args);
          };
        },
      });
      const result = await act(watched, at).then(
        () => 'ok',
        (error) => error.message,
      );
      expect.soft(calls, `${name}: ${result}`).toBeGreaterThan(0);
    }
  } finally {
    await browser.close();
  }
});

it('refuses a panel whose width number changes but whose drawn width does not', async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <section id="panel" style="position:absolute;left:400px;top:0;width:400px;height:400px">
        <div role="separator" aria-label="Panel width" aria-valuenow="400"
          style="width:8px;height:300px"></div>
      </section>
      <script>
        document.addEventListener('mouseup', () => {
          document.querySelector('[role=separator]').setAttribute('aria-valuenow', '280');
        });
      </script>
    `);
    const before = await page.locator('#panel').boundingBox();
    const act = SHELL.find((c) => c.unit === 'U08, U12')!.steps.find(([name]) =>
      name.startsWith('Drag a panel grip'),
    )![1];
    const outcome = await act(page, at).then(
      () => 'ok',
      () => 'red',
    );
    expect(await page.locator('#panel').boundingBox()).toEqual(before);
    expect(outcome, 'The rendered panel stayed exactly 400px wide').toBe('red');
  } finally {
    await browser.close();
  }
});
