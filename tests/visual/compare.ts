// SPDX-License-Identifier: AGPL-3.0-only
// Red stub (T4c): the comparison lands in the next commit.

export type Tolerance = { channel: number; maxRatio: number; maxPixels: number };
export const TOLERANCE: Readonly<Tolerance> = { channel: 1, maxRatio: 0.0002, maxPixels: 100 };
export type Verdict = {
  capture: string;
  pass: boolean;
  differing: number;
  allowed: number;
  line: string;
};

export function assertTolerance(_packed: Tolerance): void {
  throw new Error('not built');
}

export function comparePng(_capture: string, _expected: Buffer, _actual: Buffer): Verdict {
  throw new Error('not built');
}
