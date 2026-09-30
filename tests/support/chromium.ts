// SPDX-License-Identifier: AGPL-3.0-only
//
// Every Chromium the test run starts, started through one door.

import { chromium, type Browser, type BrowserType, type LaunchOptions } from 'playwright';

export type Launcher = Pick<BrowserType, 'launch'>;

export function launchChromium(
  options: LaunchOptions = {},
  launcher: Launcher = chromium,
): Promise<Browser> {
  return launcher.launch(options);
}
