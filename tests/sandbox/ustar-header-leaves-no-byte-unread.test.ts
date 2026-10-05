// SPDX-License-Identifier: AGPL-3.0-only
//
// O1 and O2 (docs/plan/sandbox-contract.md, section 7) as a closed grammar:
// no header byte means one thing to this reader and another to Docker's
// tar library. An entry's last segment always comes through the name field
// (so the layer rewrite can always split it again), and the pad and device
// fields hold only zeros or octal, which Go's archive/tar would otherwise
// read as another format or refuse, and a file's padding is zeros.

import { expect, it } from 'vitest';
import { OUTPUT_CAP, readOutput } from '../../packages/core-sandbox/src/ustar-reader.ts';
import { dir, END, file, header, tar } from './ustar-fixture.ts';

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);
const refused = (why: string) => ({ ok: false, reason: 'output refused', why });
const build = (...chunks: Uint8Array[]) => readOutput('build', OUTPUT_CAP.S1, ...chunks);
const poked = (poke: [number, Uint8Array][]) =>
  build(tar(dir('dist'), file('dist/a', 'x', { poke })));

it('refuses an empty name field, so every last segment came through the name field', () => {
  const prefixOnly = header({ name: '', type: '5', prefix: `dist/${'a'.repeat(142)}` });
  expect(build(tar(dir('dist'), prefixOnly))).toEqual(refused('tar name'));
  expect(build(tar(dir('dist'), dir('dist/a'), header({ name: '', prefix: 'dist/a' })))).toEqual(
    refused('tar name'),
  );
});

it('refuses a header whose pad or device fields hold anything but zeros or octal', () => {
  expect(poked([[508, ascii('tar\0')]])).toEqual(refused('tar block'));
  expect(poked([[500, Uint8Array.of(1)]])).toEqual(refused('tar block'));
  expect(poked([[511, Uint8Array.of(1)]])).toEqual(refused('tar block'));
  expect(poked([[329, ascii('zzzzzzz\0')]])).toEqual(refused('tar block'));
  expect(poked([[337, ascii('0000x00\0')]])).toEqual(refused('tar block'));
  expect(
    poked([
      [329, ascii('0000000\0')],
      [337, ascii('0000000\0')],
    ]),
  ).toMatchObject({ ok: true });
});

it('refuses a byte other than zero in the padding after a file', () => {
  const padded = Buffer.concat([dir('dist'), file('dist/a', 'x')]);
  padded[512 + 512 + 1] = 0x20;
  expect(build(padded, END)).toEqual(refused('tar block'));
});

it('reads a second end block the cap cuts whole and judges it as a larger cap would', () => {
  for (const at of [999_936, 1_000_100]) {
    const stream = tar(dir('dist'), file('dist/a', new Uint8Array(998_400)));
    stream[at] = 1;
    expect(readOutput('build', OUTPUT_CAP.S0, stream)).toEqual(refused('tar end'));
    expect(readOutput('build', stream.length, stream)).toEqual(refused('tar end'));
  }
});

it('judges a block the cap cuts as a larger cap would, and refuses a valid one for the cap', () => {
  const cap = 512 + 100;
  const cases: [Uint8Array, string][] = [
    [file('dist/a', 'x', { checksumField: ascii('0000000\0') }), 'tar checksum'],
    [file('dist/a', 'x', { magic: 'ustaR\0' }), 'tar magic'],
    [header({ name: 'dist/a', type: '1' }), 'tar type'],
    [file('dist/a b', 'x'), 'tar name'],
    [file('dist/a', 'x', { poke: [[511, Uint8Array.of(1)]] }), 'tar block'],
  ];
  for (const [entry, why] of cases) {
    const stream = tar(dir('dist'), entry);
    expect(readOutput('build', cap, stream)).toEqual(refused(why));
    expect(readOutput('build', stream.length, stream)).toEqual(refused(why));
  }
  const valid = tar(dir('dist'), file('dist/a', 'x'));
  expect(readOutput('build', cap, valid)).toEqual(refused('too large'));
  expect(readOutput('build', valid.length - 100, valid)).toEqual(refused('too large'));
  expect(readOutput('build', cap, valid.subarray(0, 700))).toEqual(refused('tar end'));
  expect(readOutput('build', 700, valid.subarray(0, 700))).toEqual(refused('tar end'));
});
