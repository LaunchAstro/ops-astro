// SPDX-License-Identifier: AGPL-3.0-only
//
// The pixel comparison, and the tolerance T4c ratifies (spike RN-08).
//
// A pixel differs when any channel differs by more than 1. A capture passes
// when its differing pixels are at most 0.02 percent of its area and at most
// 100 pixels, whichever is lower; any size mismatch fails. The cap is the
// decision the spike left open: a token used on a few pixels moves less than
// 0.02 percent of a tall capture (about 500 pixels at 900 by 2164), so the
// catalogue clips each capture to one region and the cap bounds whatever a
// region still holds. With the renderer pinned the floor is zero, so the
// margin is for the one-time app-against-mockup measurement, re-fixed once
// before the first recorded run if needed and never after a failure.

import { PNG } from 'pngjs';

export type Tolerance = { channel: number; maxRatio: number; maxPixels: number };
export const TOLERANCE: Readonly<Tolerance> = { channel: 1, maxRatio: 0.0002, maxPixels: 100 };

export type Verdict = {
  capture: string;
  pass: boolean;
  differing: number;
  allowed: number;
  line: string;
  diff?: Buffer;
};

/** The packet records the tolerance; one that differs from this file refuses. */
export function assertTolerance(packed: Tolerance): void {
  for (const key of Object.keys(TOLERANCE) as (keyof Tolerance)[]) {
    if (packed[key] !== TOLERANCE[key]) {
      throw new Error(
        `visual: the packet's tolerance ${key}=${String(packed[key])} is not the ratified ` +
          `${String(TOLERANCE[key])}; an edited tolerance refuses`,
      );
    }
  }
}

/** Compares two captures and names the capture in the verdict line. */
export function comparePng(capture: string, expected: Buffer, actual: Buffer): Verdict {
  const a = PNG.sync.read(expected);
  const b = PNG.sync.read(actual);
  if (a.width !== b.width || a.height !== b.height) {
    const line = `FAIL ${capture}: size ${b.width}x${b.height}, expected ${a.width}x${a.height}`;
    return { capture, pass: false, differing: a.width * a.height, allowed: 0, line };
  }
  const area = a.width * a.height;
  const allowed = Math.min(Math.floor(area * TOLERANCE.maxRatio), TOLERANCE.maxPixels);
  const diff = new PNG({ width: a.width, height: a.height });
  let differing = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let differs = false;
    for (let c = 0; c < 4; c += 1) {
      if (Math.abs((a.data[i + c] ?? 0) - (b.data[i + c] ?? 0)) > TOLERANCE.channel) differs = true;
    }
    if (differs) differing += 1;
    // Differing pixels in red over a faded copy of the expected capture.
    diff.data[i] = differs ? 255 : 255 - ((255 - (a.data[i] ?? 0)) >> 2);
    diff.data[i + 1] = differs ? 0 : 255 - ((255 - (a.data[i + 1] ?? 0)) >> 2);
    diff.data[i + 2] = differs ? 0 : 255 - ((255 - (a.data[i + 2] ?? 0)) >> 2);
    diff.data[i + 3] = 255;
  }
  const pass = differing <= allowed;
  const pct = ((differing / area) * 100).toFixed(4);
  const line = `${pass ? 'pass' : 'FAIL'} ${capture}: ${differing} pixel(s) differ (${pct} %), ${allowed} allowed`;
  return { capture, pass, differing, allowed, line, diff: PNG.sync.write(diff) };
}
