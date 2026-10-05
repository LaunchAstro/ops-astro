// SPDX-License-Identifier: AGPL-3.0-only
//
// O1 (docs/plan/sandbox-contract.md, section 7): a `site.build` run's stdout
// is one ustar stream read in memory as a closed grammar. Files and
// directories only; ustar magic and version; octal sizes, 0 for a
// directory; every checksum verified; exactly two zero blocks at the end and
// nothing after; a parent directory entry before each entry; canonical
// names under `dist`, unique after ASCII case folding; at most 5,000
// entries; the size cap counted on stream bytes; mode, owner and time
// ignored. The reader refuses at the first byte that breaks a rule, so a
// size-cap refusal means every earlier byte passed (F1's `output` crossing).

import { expect, it } from 'vitest';
import {
  OUTPUT_CAP,
  readOutput,
  UstarReader,
} from '../../packages/core-sandbox/src/ustar-reader.ts';
import { dir, END, file, filled, header, symlink, tar } from './ustar-fixture.ts';

const CAP = OUTPUT_CAP.S1;
const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);
const refused = (why: string) => ({ ok: false, reason: 'output refused', why });
const build = (...chunks: Uint8Array[]) => readOutput('build', CAP, ...chunks);

const after = (at: number): [number, Uint8Array][] => [[at, Uint8Array.of(0x61)]];
const manyFiles = (count: number): Uint8Array[] => [
  dir('dist'),
  ...Array.from({ length: count - 1 }, (_, n) => file(`dist/${n}`, '')),
];

const SITE = tar(
  dir('dist'),
  file('dist/index.html', '<p>hi</p>'),
  dir('dist/a'),
  file('dist/a/b.css', 'p{}'),
);

it('reads a valid build stream as its entries, names canonical', () => {
  expect(build(SITE)).toEqual({
    ok: true,
    entries: [
      { type: 'directory', name: 'dist' },
      { type: 'file', name: 'dist/index.html', data: ascii('<p>hi</p>'), executable: false },
      { type: 'directory', name: 'dist/a' },
      { type: 'file', name: 'dist/a/b.css', data: ascii('p{}'), executable: false },
    ],
  });
});

it('reads the same entries however the stream is cut into chunks', () => {
  const whole = build(SITE);
  const bytes = [...SITE].map((byte) => Uint8Array.of(byte));
  expect(build(...bytes)).toEqual(whole);
  expect(build(SITE.subarray(0, 700), SITE.subarray(700, 1800), SITE.subarray(1800))).toEqual(
    whole,
  );
});

it('accepts an empty stream of two zero blocks', () => {
  expect(build(END)).toEqual({ ok: true, entries: [] });
});

it('joins prefix and name, and holds the joined path to 255 bytes', () => {
  const top = `dist/${'d'.repeat(70)}`;
  const leaf = 'f'.repeat(100);
  const under = (last: string) => {
    const parent = `${top}/${last}`;
    return build(
      tar(dir('dist'), dir(top), dir(last, { prefix: top }), file(leaf, 'x', { prefix: parent })),
    );
  };
  const ok = under('e'.repeat(69));
  expect(ok).toMatchObject({ ok: true });
  expect(ok.ok && ok.entries[3]?.name).toBe(`${top}/${'e'.repeat(69)}/${leaf}`);
  expect(`${top}/${'e'.repeat(78)}/${leaf}`).toHaveLength(255);
  expect(under('e'.repeat(78))).toMatchObject({ ok: true });
  expect(under('e'.repeat(79))).toEqual(refused('tar name'));
});

it('refuses every entry type but a file or a directory', () => {
  for (const type of ['\0', '1', '2', '3', '4', '6', '7', 'x', 'g', 'L', 'K', 'S', 'A', 'D']) {
    expect(build(tar(dir('dist'), header({ name: 'dist/x', type })))).toEqual(refused('tar type'));
  }
  expect(build(tar(dir('dist'), symlink('dist/l', 'index.html')))).toEqual(refused('tar type'));
});

it('refuses a magic or version other than ustar and 00', () => {
  for (const magic of ['ustar ', 'ustaR\0', '\0\0\0\0\0\0']) {
    expect(build(tar(header({ name: 'dist/', type: '5', magic })))).toEqual(refused('tar magic'));
  }
  for (const version of [' \0', '01', '0\0']) {
    expect(build(tar(header({ name: 'dist/', type: '5', version })))).toEqual(refused('tar magic'));
  }
  expect(build(tar(header({ name: 'dist/', type: '5', magic: 'ustar ', version: ' \0' })))).toEqual(
    refused('tar magic'),
  );
});

it('verifies every header checksum, unsigned, as octal', () => {
  const good = dir('dist');
  const sum = good.reduce((s, b, at) => s + (at >= 148 && at < 156 ? 32 : b), 0);
  const field = (text: string) => ascii(text.padEnd(8, '\0').slice(0, 8));
  expect(build(tar(dir('dist', { checksumField: field(`${sum.toString(8)} `) })))).toMatchObject({
    ok: true,
  });
  expect(build(tar(dir('dist', { checksumField: field(`${(sum + 1).toString(8)}\0`) })))).toEqual(
    refused('tar checksum'),
  );
  for (const text of ['', ' 1234\0', '12x4\0', '9999\0', '00001234']) {
    expect(build(tar(dir('dist', { checksumField: field(text) })))).toEqual(
      refused('tar checksum'),
    );
  }
  // A byte over 127 in an ignored field: the signed sum differs from the unsigned one.
  const high: [number, Uint8Array][] = [[265, Uint8Array.of(0xff)]];
  expect(build(tar(dir('dist', { poke: high })))).toMatchObject({ ok: true });
  const signed = header({ name: 'dist/', type: '5', mode: '0000755\0', poke: high });
  const signedSum = signed.reduce(
    (s, b, at) => s + (at >= 148 && at < 156 ? 32 : b > 127 ? b - 256 : b),
    0,
  );
  expect(
    build(tar(dir('dist', { poke: high, checksumField: field(`${signedSum.toString(8)}\0 `) }))),
  ).toEqual(refused('tar checksum'));
});

it('reads sizes as octal only, and 0 for a directory', () => {
  const sized = (sizeField: Uint8Array) =>
    build(tar(dir('dist'), header({ name: 'dist/a', sizeField })));
  expect(sized(ascii('0\0\0\0\0\0\0\0\0\0\0\0'))).toMatchObject({ ok: true });
  expect(sized(ascii('00000000000 '))).toMatchObject({ ok: true });
  const base256 = new Uint8Array(12);
  base256[0] = 0x80;
  expect(sized(base256)).toEqual(refused('tar size'));
  for (const text of [
    ' 0000000000\0',
    '0000000008\0\0',
    '\0\0\0\0\0\0\0\0\0\0\0\0',
    '000000000000',
    '0 1\0\0\0\0\0\0\0\0\0',
    '-1\0\0\0\0\0\0\0\0\0\0',
  ]) {
    expect(sized(ascii(text))).toEqual(refused('tar size'));
  }
  expect(build(tar(dir('dist', { size: 1 })))).toEqual(refused('tar size'));
});

it('refuses a link name on a file or a directory', () => {
  expect(build(tar(dir('dist', { link: 'x' })))).toEqual(refused('tar link'));
  expect(build(tar(dir('dist'), file('dist/a', 'x', { link: 'dist' })))).toEqual(
    refused('tar link'),
  );
});

it('refuses a name that is not canonical, outside dist, or outside its character set', () => {
  for (const name of [
    './dist/x',
    '/dist/x',
    'dist//x',
    'dist/./x',
    'dist/../x',
    'dist/.',
    'dist/..',
    'dist/x/',
    'dist/bad name.html',
    'dist/café.html',
    'dist/a\\b',
    'dist/a:b',
    'Dist/x',
    'dist2/x',
    'distx',
    '',
  ]) {
    expect(build(tar(dir('dist'), file(name, 'x'))), name).toEqual(refused('tar name'));
  }
  expect(build(tar(dir('dist'), dir('dist//x')))).toEqual(refused('tar name'));
  expect(build(tar(dir('dist'), dir('dist/x//')))).toEqual(refused('tar name'));
  for (const name of ['dist/a~b@c+d-e_f.g', 'dist/.well-known', 'dist/...']) {
    expect(build(tar(dir('dist'), file(name, 'x'))), name).toMatchObject({ ok: true });
  }
});

it('refuses bytes after the first NUL of a name, prefix or link name', () => {
  expect(build(tar(dir('dist'), file('dist/a', 'x', { poke: after(50) })))).toEqual(
    refused('tar name'),
  );
  expect(build(tar(dir('dist'), file('dist/a', 'x', { poke: after(400) })))).toEqual(
    refused('tar name'),
  );
  expect(build(tar(dir('dist'), file('dist/a', 'x', { poke: after(200) })))).toEqual(
    refused('tar link'),
  );
});

it('refuses an entry whose parent directory has no earlier entry of its own', () => {
  expect(build(tar(file('dist/a', 'x')))).toEqual(refused('tar parent'));
  expect(build(tar(dir('dist'), file('dist/a/b', 'x'), dir('dist/a')))).toEqual(
    refused('tar parent'),
  );
  expect(build(tar(dir('dist'), dir('dist/a/b')))).toEqual(refused('tar parent'));
  expect(build(tar(dir('dist'), file('dist/a', 'x'), file('dist/a/b', 'x')))).toEqual(
    refused('tar parent'),
  );
});

it('refuses a root dist that is not a directory', () => {
  expect(build(tar(file('dist', 'x')))).toEqual(refused('tar type'));
});

it('refuses two names that are equal after ASCII case folding', () => {
  expect(build(tar(dir('dist'), file('dist/A.html', 'x'), file('dist/a.html', 'y')))).toEqual(
    refused('tar duplicate'),
  );
  expect(build(tar(dir('dist'), file('dist/a', 'x'), file('dist/a', 'x')))).toEqual(
    refused('tar duplicate'),
  );
  expect(build(tar(dir('dist'), dir('dist/a'), file('dist/A', 'x')))).toEqual(
    refused('tar duplicate'),
  );
  expect(build(tar(dir('dist'), dir('DIST')))).toEqual(refused('tar name'));
});

it('ends with exactly two zero blocks and nothing after them', () => {
  const body = Buffer.concat([dir('dist'), file('dist/a', 'x')]);
  expect(build(body, new Uint8Array(512))).toEqual(refused('tar end'));
  expect(build(body)).toEqual(refused('tar end'));
  expect(build(body, END, new Uint8Array(512))).toEqual(refused('tar end'));
  expect(build(body, END, Uint8Array.of(0))).toEqual(refused('tar end'));
  expect(build(body, new Uint8Array(512), dir('dist/b'), END)).toEqual(refused('tar end'));
  expect(build(body.subarray(0, 600))).toEqual(refused('tar end'));
  expect(build(body.subarray(0, 1100))).toEqual(refused('tar end'));
  expect(build(body.subarray(0, 300))).toEqual(refused('tar end'));
  expect(build(new Uint8Array())).toEqual(refused('tar end'));
});

it('ignores mode, owner and time fields in a build', () => {
  const poke = [
    filled(100, 8),
    filled(108, 8),
    filled(116, 8),
    filled(136, 12),
    filled(265, 32),
    filled(297, 32),
  ];
  expect(build(tar(dir('dist', { poke }), file('dist/a', 'x', { poke })))).toMatchObject({
    ok: true,
  });
});

it('holds a build to 5,000 entries', () => {
  expect(build(tar(...manyFiles(5000)))).toMatchObject({ ok: true });
  expect(build(tar(...manyFiles(5001)))).toEqual(refused('too many entries'));
});

it('counts the size cap on stream bytes and refuses past it only after every earlier byte passed', () => {
  expect(readOutput('build', SITE.length, SITE)).toMatchObject({ ok: true });
  expect(readOutput('build', SITE.length - 1, SITE)).toEqual(refused('too large'));
  const badAfterCap = Buffer.concat([SITE.subarray(0, 2048), file('dist/bad name', 'x'), END]);
  expect(readOutput('build', 2048, badAfterCap)).toEqual(refused('too large'));
  expect(readOutput('build', 2048 + 512, badAfterCap)).toEqual(refused('tar name'));
  expect(OUTPUT_CAP).toEqual({ S0: 1_000_000, S1: 50_000_000, S2: 1_000_000_000 });
});

it('keeps its first refusal and reads nothing after it', () => {
  const reader = new UstarReader('build', CAP);
  reader.push(file('dist/a', 'x'));
  expect(reader.end()).toEqual(refused('tar parent'));
  reader.push(dir('dist'), END);
  expect(reader.end()).toEqual(refused('tar parent'));
  expect(reader.end()).toEqual(refused('tar parent'));
});

it('refuses a byte other than zero in the padding after a file', () => {
  const padded = Buffer.concat([dir('dist'), file('dist/a', 'x')]);
  padded[512 + 512 + 1] = 0x20;
  expect(build(padded, END)).toEqual(refused('tar block'));
});

it('refuses for the cap only at the byte past it, never from a declared size', () => {
  const head = Buffer.concat([dir('dist'), header({ name: 'dist/big', size: 4096 })]);
  const cap = 1024 + 4095;
  expect(readOutput('build', cap, head)).toEqual(refused('tar end'));
  expect(readOutput('build', cap, head, new Uint8Array(4095))).toEqual(refused('tar end'));
  expect(readOutput('build', cap, head, new Uint8Array(4096))).toEqual(refused('too large'));
  expect(readOutput('build', 1024 + 4096 + 1024, head, new Uint8Array(4096), END)).toMatchObject({
    ok: true,
  });
});

it("books a file's bytes as they arrive, not its declared size", () => {
  const before = process.memoryUsage().arrayBuffers;
  const reader = new UstarReader('prepare', OUTPUT_CAP.S2);
  reader.push(dir('node_modules'), header({ name: 'node_modules/big', size: 999_000_000 }));
  expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(10_000_000);
  expect(reader.end()).toEqual(refused('tar end'));
});
