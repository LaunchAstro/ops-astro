// SPDX-License-Identifier: AGPL-3.0-only
//
// Every Chromium the test run starts, started through one door.
//
// On Linux, Playwright starts Chromium with --disable-dev-shm-usage, so its
// shared memory is made as `.org.chromium.Chromium.*` files in TMPDIR, each
// unlinked once mapped. A Chromium process that ends between the two (a
// renderer stopped at shutdown, just after close resolves) leaves the file,
// and the run's temp guard fails on it. So each browser gets a temp folder of
// its own, removed after its close, whether the close succeeds or not.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserType, type LaunchOptions } from 'playwright';

export type Launcher = Pick<BrowserType, 'launch'>;

export async function launchChromium(
  options: LaunchOptions = {},
  launcher: Launcher = chromium,
): Promise<Browser> {
  const temp = mkdtempSync(join(tmpdir(), 'chromium-'));
  const remove = () => rmSync(temp, { recursive: true, force: true });
  let browser: Browser;
  try {
    browser = await launcher.launch({
      ...options,
      env: { ...process.env, ...options.env, TMPDIR: temp },
    });
  } catch (error) {
    remove();
    throw error;
  }
  const close = browser.close.bind(browser);
  browser.close = async (...args) => {
    try {
      await close(...args);
    } finally {
      remove();
    }
  };
  return browser;
}
