// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock on MP-1-7's width-and-theme harness: the app served from source
// with no API behind it, a real browser, and the made-up session, so every
// agency page draws the shell and its dock. Each width and theme gets one
// signed-in side; the caller loads the pages it measures on it.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChromium } from '../support/chromium.ts';
import { madeUpSession, serveApp } from '../visual/app-pages.ts';
import { openSide, type Catalogue, type Side } from '../visual/capture.ts';
import {
  fetchAssets,
  MODE,
  readAssets,
  readPacket,
  type Packet,
  type Theme,
} from '../visual/packet.ts';

export interface DockSide {
  readonly side: Side;
  readonly packet: Packet;
  readonly app: URL;
  readonly width: number;
  readonly theme: Theme;
  /** The regions the catalogue masks (`states.json`). */
  readonly mask: string[];
}

/** Runs `each` on a signed-in side at every width in every theme, one at a time. */
export async function onDockSides(
  widths: readonly number[],
  themes: readonly Theme[],
  each: (at: DockSide) => Promise<void>,
): Promise<void> {
  const packet = readPacket();
  const { mask } = JSON.parse(
    readFileSync(new URL('../visual/states.json', import.meta.url), 'utf8'),
  ) as Catalogue;
  await fetchAssets(readAssets(), packet);
  // No browser, no capture: the launch fails the test, never skips it.
  const browser = await launchChromium(MODE);
  const { app, close } = await serveApp();
  const scratch = mkdtempSync(join(tmpdir(), 'dock-harness-'));
  try {
    const session = madeUpSession(app, scratch);
    for (const width of widths) {
      for (const theme of themes) {
        // oxlint-disable-next-line no-await-in-loop -- one width and theme at a time, in order
        const side = await openSide(browser, packet, width, { app, session, colorScheme: theme });
        try {
          // oxlint-disable-next-line no-await-in-loop -- as above
          await each({ side, packet, app, width, theme, mask });
        } finally {
          // oxlint-disable-next-line no-await-in-loop -- as above
          await side.context.close();
        }
      }
    }
  } finally {
    await browser.close();
    await close();
    rmSync(scratch, { recursive: true, force: true });
  }
}
