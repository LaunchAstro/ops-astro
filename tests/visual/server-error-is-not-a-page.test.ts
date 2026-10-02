// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- jsdom ships no declarations; this proof only reads its DOM document
import { JSDOM } from 'jsdom';
import { PNG } from 'pngjs';
import { expect, it, vi } from 'vitest';
import { screenOf } from './app-pages.ts';
import { readPacket } from './packet.ts';
import { DARK_PENDING, report } from './report.ts';

it('a server error is not a captured app page', () => {
  const directory = mkdtempSync(join(tmpdir(), 'server-error-capture-'));
  const dom = new JSDOM(
    '<div id="app"><p>Ops Astro cannot reach its server. Reload the page to try again.</p></div>',
  );
  vi.stubGlobal('document', dom.window.document);
  try {
    const picture = join(directory, 'error.png');
    writeFileSync(picture, PNG.sync.write(new PNG({ width: 390, height: 1 })));
    const drew = screenOf();
    const wrong = drew === 'the page' ? {} : { wrongScreen: `drew ${drew}, not the page` };
    const packet = {
      ...readPacket(),
      widths: [390],
      themes: { light: 'captured', dark: DARK_PENDING },
    };
    const result = report(packet, ['agency:projects-board'], [
      { page: 'agency:projects-board', width: 390, theme: 'light', picture, overflow: 0, ...wrong },
    ]);
    expect(result.failed).toBe(1);
  } finally {
    vi.unstubAllGlobals();
    dom.window.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
