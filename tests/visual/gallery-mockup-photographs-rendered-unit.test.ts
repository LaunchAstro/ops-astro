// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const { observed } = vi.hoisted(() => ({ observed: { clonedGalleryUnits: 0 } }));

function image(red: number): Buffer {
  const png = new PNG({ width: 16, height: 16 });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = red;
    png.data[offset + 1] = 0;
    png.data[offset + 2] = 0;
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

const mockupPixels = image(255);
const differentPixels = image(0);

vi.mock('playwright', () => ({
  chromium: { launch: () => Promise.resolve({ close: () => Promise.resolve() }) },
}));
vi.mock('./app-pages.ts', () => ({
  madeUpSession: () => '/private/tmp/sol-made-up-session',
  serveApp: () =>
    Promise.resolve({ app: new URL('http://app.invalid/'), close: () => Promise.resolve() }),
}));
vi.mock('./capture.ts', () => ({
  MOCKUP_ORIGIN: 'http://mockup.invalid',
  openSide: () => Promise.resolve({ context: { close: () => Promise.resolve() } }),
  load: (_side: unknown, _packet: unknown, url: string) => {
    const gallery = url.startsWith('http://app.invalid');
    let unit = '';
    return Promise.resolve({
      evaluate: (fn: { name: string }, value?: string) => {
        if (fn.name === 'textFamilies')
          return Promise.resolve(['Chivo Mono', 'Funnel Display', 'Funnel Sans']);
        if (fn.name === 'markupOf') {
          unit = value ?? '';
          return Promise.resolve(`<span data-unit="${unit}">Sample</span>`);
        }
        if (fn.name === 'place') {
          if (gallery) observed.clonedGalleryUnits += 1;
          unit = value ?? '';
          return Promise.resolve({ x: 0, y: 0, width: 16, height: 16 });
        }
        throw new Error(`Unexpected browser evaluation: ${fn.name}`);
      },
      // A planted defect makes the actual gallery primary button black. The
      // injected mockup clone is white, so photographing the clone hides it.
      locator: () => ({ screenshot: () => Promise.resolve(differentPixels) }),
      screenshot: () =>
        Promise.resolve(
          gallery &&
            (unit.includes('data-unit=".btn[data-unwired]"') || unit.includes('data-unit=".fresh"'))
            ? differentPixels
            : mockupPixels,
        ),
    });
  },
}));
vi.mock('./gallery-views.ts', () => ({ WIDTHS: [390] }));
vi.mock('./packet.ts', () => ({
  checkMockupTree: () => 'pinned-tree',
  checkRenderer: () => {},
  fetchAssets: () => Promise.resolve(),
  liveRenderer: () => ({}),
  MODE: { headless: true },
  readAssets: () => ({ assets: [] }),
  readPacket: () => ({ mockup: {}, renderer: {} }),
  themesOf: () => ['light'],
}));

let evidence: string;
let summary: string;
let exitCode: number | string | undefined;

beforeAll(async () => {
  evidence = mkdtempSync(join(tmpdir(), 'sol-u04-gallery-unit-'));
  const previousDir = process.env['MOCKUP_DIR'];
  const previousArgs = process.argv;
  const previousExit = process.exitCode;
  try {
    process.env['MOCKUP_DIR'] = '/private/tmp/sol-pinned-mockup';
    process.argv = [...previousArgs, '--out', evidence];
    process.exitCode = 0;
    await import('./gallery-mockup.ts');
    summary = readFileSync(join(evidence, 'summary.txt'), 'utf8');
    exitCode = process.exitCode;
  } finally {
    if (previousDir === undefined) delete process.env['MOCKUP_DIR'];
    else process.env['MOCKUP_DIR'] = previousDir;
    process.argv = previousArgs;
    process.exitCode = previousExit;
  }
});

afterAll(() => {
  rmSync(evidence, { recursive: true, force: true });
});

it('MP-1-3 the local mockup comparison photographs the rendered gallery component', () => {
  expect(summary).toContain('ok MP-1-3 primary-button@390-light');
  expect(exitCode).toBe(1);
  expect(observed.clonedGalleryUnits).toBe(0);
});
