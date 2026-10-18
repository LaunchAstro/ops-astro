// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { Missed } from './owner-checks-steps.ts';
import { sourceOf } from './owner-checks-source.ts';
import { SHELL } from './owner-checks-shell.ts';
import { FOUNDATION } from './owner-checks-foundation.ts';
import { launchChromium } from '../support/chromium.ts';

const at = { app: new URL('https://app.opsastro.com'), stamp: '070489fd921d' };

// Copied from Sol's review of #1809 (head 070489f). The first two are bound to
// the runner's own seams: the source it films (owner-checks-source.ts, where
// the local server is only for --local), and the teammate step with no login,
// which the orchestrator ruled must fail red naming #1808, never skip.

it('films the deployed made-up build unless told --local', () => {
  const source = sourceOf([]);
  expect(source.kind === 'deployed' ? source.app.origin : source.kind).toBe(at.app.origin);
  expect(sourceOf(['--local']).kind).toBe('local');
});

it('runs the teammate authenticator check, and with no teammate login fails it red naming #1808', async () => {
  const check = SHELL.find((one) => one.unit === 'U10')!;
  const step = check.steps.find(([name]) => name.startsWith('The teammate signs in:'))!;
  delete process.env['OWNER_CHECK_TEAMMATE_EMAIL'];
  delete process.env['OWNER_CHECK_TEAMMATE_PASSWORD'];
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    const missed = await step[1](page, at).then(
      () => 'ran',
      (error: unknown) => error,
    );
    expect(missed).toBeInstanceOf(Missed);
    expect((missed as Missed).kind).toBe('red');
    expect((missed as Missed).message).toContain('#1808');
  } finally {
    await browser.close();
  }
});

it('refuses a panel grip that does not resize', async () => {
  const check = SHELL.find((one) => one.unit === 'U08, U12')!;
  const step = check.steps.find(([name]) => name === 'Drag a panel grip: the panel narrows')!;
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<div role="separator" style="position:absolute;left:400px;top:50px;width:8px;height:300px"></div>',
    );
    const before = await page.getByRole('separator').boundingBox();
    const result = await step[1](page, at).then(
      () => 'ok',
      () => 'red',
    );
    expect(await page.getByRole('separator').boundingBox()).toEqual(before);
    expect(result).toBe('red');
  } finally {
    await browser.close();
  }
});

it('refuses an Executive page whose second chart is not drawn', async () => {
  const check = FOUNDATION.find((one) => one.unit === 'U05')!;
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<main><svg role="img" width="300" height="150"><rect width="300" height="150" fill="blue" /></svg><svg role="img" style="display:none"></svg><div role="tooltip">42</div></main>',
    );
    expect(await page.locator('svg').nth(1).isVisible()).toBe(false);
    const result = await check.steps[0]![1](page, at).then(
      () => 'ok',
      () => 'red',
    );
    expect(result).toBe('red');
  } finally {
    await browser.close();
  }
});

// Copied from Sol's second review of #1809 (head 62dc339).

it('refuses an Executive page whose second chart is visible but draws no marks', async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<main><svg role="img" width="300" height="150"><rect width="300" height="150" fill="blue" /></svg><svg role="img" width="300" height="150"></svg><div role="tooltip">42</div></main>',
    );
    expect(await page.locator('svg').nth(1).isVisible()).toBe(true);
    expect(
      await page
        .locator('svg')
        .nth(1)
        .evaluate((node) => (node as SVGGraphicsElement).getBBox().width),
    ).toBe(0);
    await expect(
      FOUNDATION.find((c) => c.unit === 'U05')!.steps[0]![1](page, at),
    ).rejects.toThrow();
  } finally {
    await browser.close();
  }
});

it('refuses a named panel grip whose width does not change when dragged', async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<div role="separator" aria-label="Panel width" aria-valuenow="400" style="position:absolute;left:400px;top:50px;width:8px;height:300px"></div>',
    );
    const step = SHELL.find((c) => c.unit === 'U08, U12')!.steps.find(([s]) =>
      s.startsWith('Drag a panel grip'),
    )!;
    await expect(step[1](page, at)).rejects.toThrow();
  } finally {
    await browser.close();
  }
});
