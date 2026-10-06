// SPDX-License-Identifier: AGPL-3.0-only
//
// O1's size cap is counted on stream bytes (docs/plan/sandbox-contract.md,
// section 7), so a header's declared size books nothing: a file's buffer,
// its first one included, grows only toward what the cap still lets
// arrive. A run that declares 8.5 GB and sends one large piece under a 3 MB
// cap books at most 3 MB, not twice the piece. The largest array the reader
// makes is recorded directly: memory readings move with unrelated frees.

import { expect, it } from 'vitest';
import { UstarReader } from '../../packages/core-sandbox/src/ustar-reader.ts';
import { dir, header } from './ustar-fixture.ts';

/** The length of the largest Uint8Array made while `run` runs. */
function largestMade(run: () => void): number {
  const real = globalThis.Uint8Array;
  let largest = 0;
  globalThis.Uint8Array = new Proxy(real, {
    construct(target, args: unknown[], newTarget) {
      const made = Reflect.construct(target, args, newTarget) as Uint8Array;
      largest = Math.max(largest, made.length);
      return made;
    },
  });
  try {
    run();
  } finally {
    globalThis.Uint8Array = real;
  }
  return largest;
}

it('grows a file buffer only toward what the cap still lets arrive, whatever size is declared', () => {
  const cap = 3_000_000;
  const reader = new UstarReader('build', cap);
  reader.push(dir('dist'), header({ name: 'dist/big', size: 0o77777777777 }));
  const piece = new Uint8Array(2_900_000).fill(0x61);
  // The two header blocks already took 1,024 bytes of the cap.
  expect(largestMade(() => reader.push(piece))).toBeLessThanOrEqual(cap - 1024);
  reader.push(new Uint8Array(cap));
  expect(reader.end()).toEqual({ ok: false, reason: 'output refused', why: 'too large' });
});

it('books a first buffer no larger than the cap still lets arrive', () => {
  const reader = new UstarReader('build', 4096);
  const head = Buffer.concat([dir('dist'), header({ name: 'dist/big', size: 1_000_000 })]);
  expect(largestMade(() => reader.push(head))).toBeLessThanOrEqual(4096 - 1024);
});
