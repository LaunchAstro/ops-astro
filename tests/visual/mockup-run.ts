// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-await-in-loop -- widths and themes run one at a time, in
   order: one browser context at a time. */
//
// The run the local halves of the visual match share (U04's gallery-mockup.ts,
// U05's charts-mockup.ts): the pinned mockup beside the app, in the pinned
// renderer, at each width in each theme. `view` compares one width and theme
// and returns its result lines; they go to DIR/summary.txt and the console,
// and the run fails unless every line is `ok`. Needs the private mockup, so it
// runs where the mockup is (ruling (a)).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { madeUpSession, serveApp } from './app-pages.ts';
import { openSide, type Side } from './capture.ts';
import { WIDTHS } from './gallery-views.ts';
import {
  checkMockupTree,
  checkRenderer,
  fetchAssets,
  liveRenderer,
  MODE,
  readAssets,
  readPacket,
  themesOf,
  type Packet,
  type Theme,
} from './packet.ts';

/** One width in one theme; `name` is `@<width>-<theme>`, `out` the evidence folder. */
export type MockupView = {
  packet: Packet;
  app: URL;
  width: number;
  theme: Theme;
  name: string;
  out: string;
};

/** Runs `view` over every width and theme, the mockup signed out and the app signed in. */
export async function besideMockup(
  prefix: string,
  view: (sides: { mockup: Side; gallery: Side }, at: MockupView) => Promise<string[]>,
): Promise<void> {
  const mockupDir = process.env['MOCKUP_DIR'];
  if (mockupDir === undefined) throw new Error('visual: set MOCKUP_DIR to the pinned mockup clone');
  const flag = process.argv.indexOf('--out');
  const out = flag === -1 ? mkdtempSync(join(tmpdir(), prefix)) : (process.argv[flag + 1] ?? '');
  mkdirSync(out, { recursive: true });
  const packet = readPacket();
  const tree = checkMockupTree(mockupDir, packet.mockup);
  await fetchAssets(readAssets(), packet);
  const browser = await chromium.launch(MODE);
  checkRenderer(packet, liveRenderer(browser, MODE));
  const { app, close } = await serveApp();
  const lines: string[] = [];
  try {
    const session = madeUpSession(app, join(out, 'session'));
    for (const width of WIDTHS) {
      for (const theme of themesOf(packet)) {
        const mockup = await openSide(browser, packet, width, { mockupDir, tree, theme });
        const gallery = await openSide(browser, packet, width, {
          app,
          session,
          colorScheme: theme,
        });
        try {
          const name = `@${String(width)}-${theme}`;
          lines.push(
            ...(await view({ mockup, gallery }, { packet, app, width, theme, name, out })),
          );
        } finally {
          await Promise.all([mockup.context.close(), gallery.context.close()]);
        }
      }
    }
  } finally {
    rmSync(join(out, 'session'), { recursive: true, force: true });
    await browser.close();
    await close();
  }
  writeFileSync(join(out, 'summary.txt'), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  process.exitCode = lines.every((line) => line.startsWith('ok')) ? 0 : 1;
}
