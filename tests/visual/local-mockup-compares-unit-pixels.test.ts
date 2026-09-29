// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';

const { loaded } = vi.hoisted(() => ({ loaded: [] as string[] }));

const image = (red: number): Buffer => {
  const png = new PNG({ width: 390, height: 900 });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = red;
    png.data[offset + 1] = 0;
    png.data[offset + 2] = 0;
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
};

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
  load: (_side: unknown, _packet: unknown, url: string) => {
    loaded.push(url);
    return Promise.resolve({
      evaluate: () => Promise.resolve(['Chivo Mono', 'Funnel Display', 'Funnel Sans']),
      screenshot: () => Promise.resolve(image(url.startsWith('http://mockup.invalid') ? 255 : 0)),
    });
  },
  openSide: () => Promise.resolve({ context: { close: () => Promise.resolve() } }),
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
let report: string;
let result: number | string | undefined;

beforeAll(async () => {
  evidence = mkdtempSync(join(tmpdir(), 'sol-u04-mockup-'));
  const originalDir = process.env['MOCKUP_DIR'];
  const originalArgs = process.argv;
  const originalExit = process.exitCode;
  try {
    process.env['MOCKUP_DIR'] = '/private/tmp/sol-pinned-mockup';
    process.argv = [...originalArgs, '--out', evidence];
    process.exitCode = 0;
    await import('./gallery-mockup.ts');
    report = readFileSync(join(evidence, 'summary.txt'), 'utf8');
    result = process.exitCode;
  } finally {
    if (originalDir === undefined) delete process.env['MOCKUP_DIR'];
    else process.env['MOCKUP_DIR'] = originalDir;
    process.argv = originalArgs;
    process.exitCode = originalExit;
  }
});

afterAll(() => {
  rmSync(evidence, { recursive: true, force: true });
});

it('MP-1-3 different component pixels fail the local mockup comparison', () => {
  expect(loaded).toContain('http://app.invalid/gallery/');
  expect(result, report).toBe(1);
  expect(
    loaded.some(
      (url) => url.startsWith('http://mockup.invalid') && !url.includes('/agency/projects/'),
    ),
  ).toBe(true);
});

it('MP-1-6 the local comparison loads an unconnected client or workbench mockup', () => {
  expect(
    loaded.some(
      (url) => url.startsWith('http://mockup.invalid') && /\/clients\/|\/workbench\//u.test(url),
    ),
  ).toBe(true);
});
