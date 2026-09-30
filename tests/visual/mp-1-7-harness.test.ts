// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-7, the width-and-theme verification harness: one test per acceptance
// line and per supporting checklist line. These run in the required checks
// without a browser. The same harness in the pinned renderer, against the
// pinned mockup, is `node tests/visual/run.ts --prove-drift`, run locally
// where the mockup is (T4c's split); drift on the app's own page, with no
// mockup, is `run.ts --app-drift`, which the `visual drift` CI job runs on
// Linux with its own cases (`app-drift-cases.ts`).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { comparePng } from './compare.ts';
import { checkRenderer, readPacket, rendererOf, themesOf, type Packet } from './packet.ts';
import { builtPages, DARK_PENDING, overflowOf, report, type PageShot } from './report.ts';

type Rgb = readonly [number, number, number];
const WHITE: Rgb = [255, 255, 255];
const TOKEN: Rgb = [51, 85, 204];
const TOKEN_CHANGED: Rgb = [49, 82, 196];

/** A white capture as wide as the viewport, one control drawn in the token colour. */
function capture(width: number, control: { x: number; colour: Rgb }): Buffer {
  const height = 80;
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = x >= control.x && x < control.x + 60 && y >= 20 && y < 50;
      const [r, g, b] = inside ? control.colour : WHITE;
      const i = (y * width + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

// T4c's three capture widths and the four boundary widths (MP-1-7).
const WIDTHS = [1480, 900, 390, 1279, 1649, 1650, 1700];

let packet: Packet;
/** Real picture files, one per page and width, as the harness writes them. */
let pictures: string;
beforeAll(() => {
  packet = readPacket();
  pictures = mkdtempSync(join(tmpdir(), 'mp-1-7-'));
  for (const page of builtPages()) {
    for (const width of packet.widths) {
      for (const theme of themesOf(packet)) {
        writeFileSync(pictureOf(page, width, theme), capture(width, { x: 40, colour: TOKEN }));
      }
    }
  }
});
afterAll(() => {
  rmSync(pictures, { recursive: true, force: true });
});

const pictureOf = (page: string, width: number, theme = 'light'): string =>
  join(pictures, `${page.replace(':', '_')}@${width}-${theme}.page.png`);

const everyShot = (widths: readonly number[], overflow = 0, of: Packet = packet): PageShot[] =>
  builtPages().flatMap((page) =>
    widths.flatMap((width) =>
      themesOf(of).map((theme) => ({
        page,
        width,
        theme,
        picture: pictureOf(page, width, theme),
        overflow,
      })),
    ),
  );

describe('MP-1-7', () => {
  it('MP-1-7 harness bites: a control shifted 2px or a changed token fails at each width, naming the capture', () => {
    for (const width of WIDTHS) {
      expect(packet.widths, `the harness captures at ${width}`).toContain(width);
      const name = `gate@${width}-light#gatebox`;
      const base = capture(width, { x: 40, colour: TOKEN });
      expect(comparePng(name, base, capture(width, { x: 40, colour: TOKEN })).pass).toBe(true);
      const shifted = comparePng(name, base, capture(width, { x: 42, colour: TOKEN }));
      expect(shifted).toMatchObject({ capture: name, pass: false });
      expect(shifted.line).toContain(name);
      const recoloured = comparePng(name, base, capture(width, { x: 40, colour: TOKEN_CHANGED }));
      expect(recoloured).toMatchObject({ capture: name, pass: false });
      expect(recoloured.line).toContain(name);
    }
  });

  it('MP-1-7 widths: 1480, 900 and 390 plus the boundaries 1279, 1649, 1650 and 1700, in light; 1440 never a seat line', () => {
    expect(packet.widths).toEqual(WIDTHS);
    expect(packet.widths).not.toContain(1440);
    expect(packet.themes.light).toBe('captured');
  });

  it('MP-1-7 dark pending: every dark picture is marked waiting for the dark theme until U04', () => {
    // U04 (MP-1-1) has landed the dark theme on this branch, so the packet
    // captures dark; a packet that still marks it pending prints each as waiting.
    expect(packet.themes.dark).toBe('captured');
    const pending: Packet = { ...packet, themes: { ...packet.themes, dark: DARK_PENDING } };
    const { lines } = report(pending, builtPages(), everyShot(packet.widths, 0, pending));
    const dark = lines.filter((line) => line.includes('-dark'));
    expect(dark).toHaveLength(builtPages().length * packet.widths.length);
    for (const line of dark)
      expect(line).toMatch(/^pending .+@\d+-dark: waiting for the dark theme/u);
  });
});

describe('MP-1-7', () => {
  it('MP-1-7 renderer pinned: a capture from a different browser mode is refused until it is measured', () => {
    const pinned = packet.renderer;
    expect(() => checkRenderer(packet, { ...pinned })).not.toThrow();
    // Headed Chromium, or its new headless mode, is not the pinned headless shell,
    // and neither is the other: each names its mode.
    const headed = rendererOf(pinned, { headless: false });
    expect(headed.browser).toBe('chromium headed');
    expect(() => checkRenderer(packet, headed)).toThrow(/browser/u);
    const channel = rendererOf(pinned, { headless: true, channel: 'chromium' });
    expect(channel.browser).toBe('chromium new-headless');
    expect(() => checkRenderer(packet, channel)).toThrow(/browser/u);
    expect(() => checkRenderer({ ...packet, renderer: headed }, channel)).toThrow(/browser/u);
    expect(rendererOf(pinned, { headless: true })).toEqual(pinned);
    expect(() => checkRenderer(packet, { ...pinned, deviceScaleFactor: 2 })).toThrow(
      /deviceScaleFactor/u,
    );
  });
});

describe('MP-1-7 report', () => {
  zeroHorizontalOverflow();
  everyPageBuiltSoFar();
  pinnedMockupBaseline();
});

function zeroHorizontalOverflow(): void {
  it('MP-1-7 zero horizontal overflow: a page that scrolls sideways fails, naming the page and width', () => {
    expect(overflowOf({ scrollWidth: 390, clientWidth: 390 })).toBe(0);
    expect(overflowOf({ scrollWidth: 402, clientWidth: 390 })).toBe(12);
    const shots = everyShot(packet.widths);
    const wide = shots.find((shot) => shot.page === 'agency:task-detail' && shot.width === 390);
    if (wide !== undefined) wide.overflow = 12;
    const { lines, failed } = report(packet, builtPages(), shots);
    expect(failed).toBe(1);
    expect(lines).toContain('FAIL agency:task-detail@390-light: scrolls sideways by 12 px');
    expect(report(packet, builtPages(), everyShot(packet.widths)).failed).toBe(0);
  });
}

function everyPageBuiltSoFar(): void {
  it('MP-1-7 every page built so far: each registered route has a picture at each width', () => {
    // The registry's pages: wave 0's four, U14's two, MP-1-3's gallery, MP-7-10's Team.
    expect(builtPages()).toEqual([
      'agency:sign-in',
      'agency:projects-board',
      'agency:task-detail',
      'agency:settings',
      'agency:access',
      'agency:telemetry',
      'agency:gallery',
      'agency:team',
    ]);
    const all = report(packet, builtPages(), everyShot(packet.widths));
    expect(all.failed).toBe(0);
    expect(all.lines.at(-1)).toBe(
      `width-and-theme check: ${builtPages().length} page(s) at ${packet.widths.length} width(s): ` +
        `${builtPages().length * packet.widths.length} light and ` +
        `${builtPages().length * packet.widths.length} dark picture(s), none missing; none scrolls sideways`,
    );
    // A page registered with no pictures, and one width missing on another, both fail.
    const missing = everyShot(packet.widths).filter(
      (shot) => !(shot.page === 'agency:settings' && shot.width === 1650),
    );
    const planted = report(packet, [...builtPages(), 'agency:planted'], missing);
    expect(planted.lines).toContain('FAIL agency:settings@1650-light: no picture');
    expect(planted.lines).toContain('FAIL agency:settings@1650-dark: no picture');
    expect(planted.lines).toContain('FAIL agency:planted@1480-light: no picture');
    expect(planted.lines).toContain('FAIL agency:planted@1480-dark: no picture');
    expect(planted.failed).toBe(2 * (1 + packet.widths.length));
    // A picture counts only when its file is there, as a PNG as wide as its width.
    const faked = everyShot(packet.widths);
    const swapped: Record<number, string> = {
      390: join(pictures, 'no-such.png'),
      900: pictureOf('agency:sign-in', 390),
      1480: new URL(import.meta.url).pathname,
    };
    for (const shot of faked) {
      if (shot.page === 'agency:sign-in' && shot.theme === 'light')
        shot.picture = swapped[shot.width] ?? shot.picture;
    }
    const counted = report(packet, builtPages(), faked);
    expect(counted.lines).toContain('FAIL agency:sign-in@390-light: no picture');
    expect(counted.lines).toContain(
      'FAIL agency:sign-in@900-light: picture is 390 px wide, not 900',
    );
    expect(counted.lines).toContain('FAIL agency:sign-in@1480-light: picture is not a PNG');
    expect(counted.failed).toBe(3);
  });
}

function pinnedMockupBaseline(): void {
  it('MP-1-7 pinned mockup baseline: the comparison reads the pinned tree, never a previous run', () => {
    const run = readFileSync(new URL('run.ts', import.meta.url), 'utf8');
    // Captures are written to the evidence directory and never read back from it.
    expect(run).not.toMatch(/readFileSync\(`\$\{out\}/u);
    expect(run).not.toMatch(/readFileSync\(.*\.(app|mockup)\.png/u);
    // The baseline each app capture is compared with is the mockup shot taken in the same run.
    expect(run).toMatch(/comparePng\(shot\.name, expected\[i\]\?\.png/u);
    expect(packet.mockup.tree).toMatch(/^[0-9a-f]{40}$/u);
  });
}
