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

it('refuses a non-zero byte in the second end block as it arrives, before the cap can', () => {
  const stream = tar(dir('dist'), file('dist/a', new Uint8Array(998_400)));
  stream[999_936] = 1;
  expect(readOutput('build', OUTPUT_CAP.S0, stream)).toEqual(refused('tar end'));
  expect(readOutput('build', stream.length, stream)).toEqual(refused('tar end'));
});
