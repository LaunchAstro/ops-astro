// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="dom" />
/* oxlint-disable no-await-in-loop -- widths and themes run one at a time, in
   order: one browser context at a time. */
//
// The local half of U04's visual-match legs (MP-1-2 3, MP-1-3 3, MP-1-6 3):
// the pinned mockup beside the component gallery, in the pinned renderer, at
// 1480, 900 and 390 in light and dark. Needs the private mockup, so it runs
// where the mockup is (ruling (a)); the required checks draw the gallery
// alone (gallery-views.ts).
//
//   MOCKUP_DIR=<clone of the mockup> node tests/visual/gallery-mockup.ts --out DIR
//
// It measures the families each side draws its text in (MP-1-2: the same
// three) and writes each side's picture for a person to set side by side
// (MP-1-3, MP-1-6). The gallery draws sample words and the kit rules some of
// the mockup's treatments differently (the hatch, the icon font), so no
// pixel verdict is claimed between them.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { madeUpSession, serveApp } from './app-pages.ts';
import { load, MOCKUP_ORIGIN, openSide } from './capture.ts';
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
} from './packet.ts';

/** The first family of every element that draws its own text. */
function textFamilies(): string[] {
  const families = new Set<string>();
  for (const element of document.querySelectorAll('body *')) {
    const own = [...element.childNodes].some(
      (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
    );
    if (!own || !(element instanceof HTMLElement) || !element.checkVisibility()) continue;
    const first = getComputedStyle(element).fontFamily.split(',')[0] ?? '';
    families.add(first.trim().replaceAll('"', ''));
  }
  return [...families].toSorted();
}

const picture = (page: Page): Promise<Buffer> =>
  page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' });

const mockupDir = process.env['MOCKUP_DIR'];
if (mockupDir === undefined) throw new Error('visual: set MOCKUP_DIR to the pinned mockup clone');
const at = process.argv.indexOf('--out');
const out =
  at === -1 ? mkdtempSync(join(tmpdir(), 'gallery-mockup-')) : (process.argv[at + 1] ?? '');
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
      const name = `@${width}-${theme}`;
      const mockup = await openSide(browser, packet, width, { mockupDir, tree, theme });
      const board = await load(mockup, packet, `${MOCKUP_ORIGIN}/agency/projects/`);
      const gallerySide = await openSide(browser, packet, width, {
        app,
        session,
        colorScheme: theme,
      });
      const gallery = await load(gallerySide, packet, new URL('/gallery/', app).href);
      const [left, right] = [
        await board.evaluate(textFamilies),
        await gallery.evaluate(textFamilies),
      ];
      writeFileSync(join(out, `mockup-board${name}.png`), await picture(board));
      writeFileSync(join(out, `gallery${name}.png`), await picture(gallery));
      const same = JSON.stringify(left) === JSON.stringify(right);
      lines.push(
        `${same ? 'ok' : 'FAIL'} families${name}: mockup ${left.join(', ')}; gallery ${right.join(', ')}`,
      );
      await Promise.all([mockup.context.close(), gallerySide.context.close()]);
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
