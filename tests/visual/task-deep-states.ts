// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-await-in-loop -- capture one scroll position before moving to the next. */
import type { Page } from 'playwright';
export async function captureAgentDetails(
  page: Page,
  root: string,
  capture: (name: string) => Promise<void>,
  prefix: string,
): Promise<void> {
  const run = page.locator(`${root} .trs__details`).first();
  if (await run.count()) {
    await run.evaluate((element) => {
      (element as HTMLDetailsElement).open = true;
    });
    await run.scrollIntoViewIfNeeded();
    await capture(`${prefix}-run-details`);
  }
  const workflow = page.locator(`${root} [data-agent=job-list]`).first();
  if (await workflow.count()) {
    await workflow.scrollIntoViewIfNeeded();
    if ((await workflow.getAttribute('aria-expanded')) !== 'true') await workflow.click();
    await capture(`${prefix}-workflow`);
  }
  for (const part of ['staged', 'gate', 'tokens', 'scope']) {
    const item = page.locator(`${root} [data-agent=${part}]`).first();
    if (await item.count()) {
      await item.scrollIntoViewIfNeeded();
      await capture(`${prefix}-${part}`);
    }
  }
  await page.locator(root).evaluate((element) => {
    element.scrollTop = 0;
  });
}
