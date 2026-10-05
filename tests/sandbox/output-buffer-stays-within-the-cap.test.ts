// SPDX-License-Identifier: AGPL-3.0-only
//
// O1's size cap is counted on stream bytes (docs/plan/sandbox-contract.md,
// section 7), so a header's declared size books nothing: a file's buffer,
// its first one included, grows only toward what the cap still lets
// arrive. A run that declares 8.5 GB and sends one large piece under a 3 MB
// cap holds about 3 MB, not twice the piece. Array buffer bytes are read
// alone: the heap can free unrelated bytes while a reading is taken.

import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { UstarReader } from '../../packages/core-sandbox/src/ustar-reader.ts';
import { dir, header } from './ustar-fixture.ts';

// A collection before each reading, so the reading is what is kept, not garbage.
v8.setFlagsFromString('--expose_gc');
const collect = runInNewContext('gc') as () => void;
/** Array buffer bytes still in use after a collection. */
const buffers = () => {
  collect();
  return process.memoryUsage().arrayBuffers;
};

it('grows a file buffer only toward what the cap still lets arrive, whatever size is declared', () => {
  const cap = 3_000_000;
  const reader = new UstarReader('build', cap);
  reader.push(dir('dist'), header({ name: 'dist/big', size: 0o77777777777 }));
  const piece = new Uint8Array(2_900_000).fill(0x61);
  const before = buffers();
  reader.push(piece);
  expect(buffers() - before).toBeLessThan(4_000_000);
  reader.push(new Uint8Array(cap));
  expect(reader.end()).toEqual({ ok: false, reason: 'output refused', why: 'too large' });
});

it('books a first buffer no larger than the cap still lets arrive', () => {
  const reader = new UstarReader('build', 4096);
  const head = Buffer.concat([dir('dist'), header({ name: 'dist/big', size: 1_000_000 })]);
  const before = buffers();
  reader.push(head);
  expect(buffers() - before).toBeLessThan(32_768);
});
