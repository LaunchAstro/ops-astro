// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-1-3: a component with no width of its own (the meter fills its host) is
// drawn on the mockup page at the width the gallery draws it, so the two
// pictures compare the same shape. Before, the copy sat in a host that shrank
// to its content, so the meter drew at 0 px and could not be photographed;
// the meter, alone of the units, is made to fill that host, as its own page
// host fills it. The harness's own drawing function runs here in a document,
// and the host it builds is read back.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const { placed } = vi.hoisted(() => ({ placed: [] as unknown[] }));

function image(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(255);
  return PNG.sync.write(png);
}

/** The gallery draws every unit 138 px wide; the mockup copy is whatever width it is given. */
const GALLERY_WIDTH = 138;

vi.mock('playwright', () => ({
  chromium: { launch: () => Promise.resolve({ close: () => Promise.resolve() }) },
}));
vi.mock('./app-pages.ts', () => ({
  madeUpSession: () => '/private/tmp/host-width-session',
  serveApp: () =>
    Promise.resolve({ app: new URL('http://app.invalid/'), close: () => Promise.resolve() }),
}));
vi.mock('./capture.ts', () => ({
  MOCKUP_ORIGIN: 'http://mockup.invalid',
  openSide: () => Promise.resolve({ context: { close: () => Promise.resolve() } }),
  load: (_side: unknown, _packet: unknown, url: string) => {
    const gallery = new URL(url).origin === 'http://app.invalid';
    let width = 0;
    return Promise.resolve({
      evaluate: (fn: { name: string }, value?: unknown) => {
        if (fn.name === 'textFamilies') return Promise.resolve(['Funnel Sans']);
        if (fn.name === 'markupOf') return Promise.resolve('<span class="meter"></span>');
        if (fn.name === 'place') {
          (fn as unknown as (copy: unknown) => unknown)(value);
          const host = document.querySelector<HTMLElement>('#mockup-compare');
          const copy = host?.firstElementChild;
          placed.push({
            width: host?.style.width,
            sizing: host?.style.boxSizing,
            flex: copy instanceof HTMLElement ? copy.style.flex : '',
          });
          width = (value as { width: number }).width;
          return Promise.resolve({ x: 0, y: 0, width, height: 6 });
        }
        throw new Error(`Unexpected browser evaluation: ${fn.name}`);
      },
      locator: () => ({
        screenshot: () =>
          width === 0 && !gallery
            ? Promise.reject(new Error('locator.screenshot: Timeout 10000ms exceeded.'))
            : Promise.resolve(image(gallery ? GALLERY_WIDTH : width, 6)),
      }),
      screenshot: () => Promise.resolve(image(16, 16)),
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

beforeAll(async () => {
  evidence = mkdtempSync(join(tmpdir(), 'host-width-'));
  const previousDir = process.env['MOCKUP_DIR'];
  const previousArgs = process.argv;
  const previousExit = process.exitCode;
  try {
    process.env['MOCKUP_DIR'] = '/private/tmp/host-width-mockup';
    process.argv = [...previousArgs, '--out', evidence];
    await import('./gallery-mockup.ts');
    summary = readFileSync(join(evidence, 'summary.txt'), 'utf8');
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

it("MP-1-3 the mockup copy is drawn at the gallery component's width, so the meter is photographed", () => {
  expect(placed.length).toBeGreaterThan(0);
  // Content-box: the mockup's sheet sizes borders in, which would take the padding off the width.
  for (const value of placed)
    expect(value).toMatchObject({ width: `${String(GALLERY_WIDTH)}px`, sizing: 'content-box' });
  // The meter alone fills its host; a button or chip keeps its own width.
  const fills = placed.filter((value) => (value as { flex: string }).flex === '1 1 auto');
  expect(fills).toHaveLength(1);
  expect(summary).toContain('ok MP-1-3 meter@390-light');
  expect(summary).not.toContain('not photographed');
});
