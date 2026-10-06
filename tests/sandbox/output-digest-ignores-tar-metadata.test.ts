// SPDX-License-Identifier: AGPL-3.0-only
//
// O4 (docs/plan/sandbox-contract.md, section 7): the digest of a build's
// output is the sha256 of every entry in byte order of name, each written as
// its type byte (`0` or `5`), the name's length (8 bytes, big-endian), the
// name, and for a file its size (8 bytes, big-endian) and its bytes. Tar
// order, mode, owner and time do not change it; the length fields keep two
// different outputs from hashing the same bytes.

import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { outputDigest } from '../../packages/core-sandbox/src/output-digest.ts';
import {
  OUTPUT_CAP,
  readOutput,
  type TarEntry,
} from '../../packages/core-sandbox/src/ustar-reader.ts';
import { dir, file, filled, tar } from './ustar-fixture.ts';

const entriesOf = (stream: Uint8Array): readonly TarEntry[] => {
  const read = readOutput('build', OUTPUT_CAP.S1, stream);
  if (!read.ok) throw new Error(`fixture refused: ${read.why}`);
  return read.entries;
};
const digestOf = (...parts: Uint8Array[]): string => outputDigest(entriesOf(tar(...parts)));

const length8 = (value: number): Buffer => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(value));
  return out;
};

it('hashes each entry in byte order of name, written as the contract spells it', () => {
  const stream = tar(
    dir('dist'),
    file('dist/a0', 'zero'),
    dir('dist/a'),
    file('dist/a/x', 'ax'),
    file('dist/a-b', 'dash'),
    file('dist/B', 'upper'),
  );
  const hash = createHash('sha256');
  const add = (type: string, name: string, body?: string) => {
    hash.update(type);
    hash.update(length8(name.length));
    hash.update(name);
    if (body !== undefined) {
      hash.update(length8(body.length));
      hash.update(body);
    }
  };
  // Byte order: 'B' (0x42) before 'a' (0x61); '-' (0x2d) before '/' (0x2f) before '0' (0x30).
  add('5', 'dist');
  add('0', 'dist/B', 'upper');
  add('5', 'dist/a');
  add('0', 'dist/a-b', 'dash');
  add('0', 'dist/a/x', 'ax');
  add('0', 'dist/a0', 'zero');
  expect(outputDigest(entriesOf(stream))).toBe(hash.digest('hex'));
});

it('gives the same digest whatever order the stream holds its entries in', () => {
  const one = digestOf(dir('dist'), file('dist/B', 'b'), file('dist/a', 'a'), dir('dist/c'));
  const two = digestOf(dir('dist'), dir('dist/c'), file('dist/a', 'a'), file('dist/B', 'b'));
  expect(two).toBe(one);
});

it('ignores mode, owner and time', () => {
  const plain = digestOf(dir('dist'), file('dist/a', 'x'));
  const poke = [100, 108, 116, 136, 265].map((at) => filled(at, 7, 0x37));
  expect(digestOf(dir('dist', { poke }), file('dist/a', 'x', { poke }))).toBe(plain);
});

it('keeps outputs apart that would collide without the length fields', () => {
  const short = digestOf(dir('dist'), file('dist/ab', 'c'));
  const long = digestOf(dir('dist'), file('dist/a', 'bc'));
  expect(short).not.toBe(long);
  const empty = digestOf(dir('dist'), file('dist/a', ''));
  const directory = digestOf(dir('dist'), dir('dist/a'));
  expect(empty).not.toBe(directory);
});

it('changes with any byte of a file', () => {
  expect(digestOf(dir('dist'), file('dist/a', 'x'))).not.toBe(
    digestOf(dir('dist'), file('dist/a', 'y')),
  );
});

it('digests a build output only, never a symlink entry', () => {
  expect(() => outputDigest([{ type: 'symlink', name: 'node_modules/l', link: 'x' }])).toThrow();
});
