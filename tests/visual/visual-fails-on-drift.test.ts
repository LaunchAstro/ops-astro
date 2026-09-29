// SPDX-License-Identifier: AGPL-3.0-only
//
// `visual_fails_on_drift` (T4c, split section 3.2): shift one control by two
// pixels or change one token colour and the comparison fails naming the
// capture; unchanged, it passes. These cases hold the comparison and the
// pins without a browser, so they run in the required checks. The same
// mutations against the pinned mockup in the pinned renderer are
// `node tests/visual/run.ts --prove-drift`, run locally where the mockup is.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { TOLERANCE, assertTolerance, comparePng } from './compare.ts';
import {
  assetsDir,
  checkAssets,
  checkMockupTree,
  checkRenderer,
  readPacket,
  verifyBytes,
  type Asset,
  type Packet,
} from './packet.ts';

type Rgb = readonly [number, number, number];
const WHITE: Rgb = [255, 255, 255];
const TOKEN: Rgb = [51, 85, 204];

/** A white capture with one control drawn in the token colour. */
function capture(width: number, height: number, control: { x: number; colour: Rgb }): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = x >= control.x && x < control.x + 60 && y >= 40 && y < 70;
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

const NAME = 'task-gate@900-light#gatebox';
const baseline = capture(200, 120, { x: 40, colour: TOKEN });

describe('visual_fails_on_drift', () => {
  it('passes an unchanged capture, naming it', () => {
    const verdict = comparePng(NAME, baseline, capture(200, 120, { x: 40, colour: TOKEN }));
    expect(verdict).toMatchObject({ capture: NAME, pass: true, differing: 0 });
  });

  it('fails a control shifted by two pixels, naming the capture', () => {
    const verdict = comparePng(NAME, baseline, capture(200, 120, { x: 42, colour: TOKEN }));
    expect(verdict.pass).toBe(false);
    expect(verdict.capture).toBe(NAME);
    expect(verdict.line).toContain(NAME);
  });

  it('fails one changed token colour, naming the capture', () => {
    const verdict = comparePng(NAME, baseline, capture(200, 120, { x: 40, colour: [51, 88, 204] }));
    expect(verdict.pass).toBe(false);
    expect(verdict.line).toContain(NAME);
  });

  it('ignores a one-unit channel difference, the ratified noise', () => {
    const verdict = comparePng(NAME, baseline, capture(200, 120, { x: 40, colour: [52, 85, 204] }));
    expect(verdict.pass).toBe(true);
  });

  it('fails any size mismatch', () => {
    const verdict = comparePng(NAME, baseline, capture(200, 121, { x: 40, colour: TOKEN }));
    expect(verdict).toMatchObject({ pass: false });
    expect(verdict.line).toMatch(/size/u);
  });

  it('catches a small defect on a tall capture through the absolute cap', () => {
    // 150 changed pixels on 390 by 6000 is 0.0064 percent, under the ratio.
    const tall = capture(390, 6000, { x: 40, colour: TOKEN });
    const defect = PNG.sync.read(tall);
    for (let i = 0; i < 150; i += 1) defect.data[(3000 * 390 + i) * 4] = 0;
    const verdict = comparePng('board@390-light#page', tall, PNG.sync.write(defect));
    expect(verdict.pass).toBe(false);
    expect(verdict.allowed).toBe(TOLERANCE.maxPixels);
  });
});

describe('the pins refuse', () => {
  let packet: Packet;
  beforeAll(() => {
    packet = readPacket();
  });

  it('an edited tolerance', () => {
    expect(() => assertTolerance(packet.tolerance)).not.toThrow();
    expect(() => assertTolerance({ ...packet.tolerance, maxRatio: 0.001 })).toThrow(/tolerance/u);
  });

  it('a renderer whose identity differs, naming the field', () => {
    expect(() => checkRenderer(packet, packet.renderer)).not.toThrow();
    const other = { ...packet.renderer, browserBuild: '0.0.0.0' };
    expect(() => checkRenderer(packet, other)).toThrow(/browserBuild/u);
  });

  it('a changed pinned mockup', () => {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const tree = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD^{tree}'], {
      encoding: 'utf8',
    }).trim();
    const pinned: Packet['mockup'] = { commit: 'HEAD', tree };
    expect(checkMockupTree(root, pinned)).toBe(tree);
    const changed = { ...pinned, tree: `${tree.slice(0, -1)}${tree.endsWith('0') ? '1' : '0'}` };
    expect(() => checkMockupTree(root, changed)).toThrow(/pinned mockup/u);
  });

  it('a bundled font whose bytes changed, naming the file', () => {
    const manifest = JSON.parse(readFileSync(`${assetsDir}/assets.json`, 'utf8')) as {
      assets: Asset[];
    };
    const font = manifest.assets.find((a) => a.file !== undefined);
    if (font?.file === undefined) throw new Error('no bundled font in the manifest');
    expect(() => verifyBytes(font, Buffer.from('not the font'))).toThrow(font.file);
  });

  it('an edited asset record', () => {
    expect(() => checkAssets(packet)).not.toThrow();
    const manifest = JSON.parse(readFileSync(`${assetsDir}/assets.json`, 'utf8')) as {
      assets: Asset[];
    };
    const font = manifest.assets.find((a) => a.file !== undefined);
    if (font === undefined) throw new Error('no bundled font in the manifest');
    font.sha256 = '0'.repeat(64);
    expect(() => checkAssets(packet, manifest)).toThrow(/asset records/u);
  });

  it('lists every width in light, and dark as captured now U04 has landed the dark theme (MP-1-1)', () => {
    expect(packet.widths.slice(0, 3)).toEqual([1480, 900, 390]);
    expect(packet.themes.dark).toBe('captured');
  });
});
