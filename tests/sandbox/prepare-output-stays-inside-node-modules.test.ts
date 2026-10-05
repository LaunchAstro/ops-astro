// SPDX-License-Identifier: AGPL-3.0-only
//
// O2 (docs/plan/sandbox-contract.md, section 7): a `site.prepare` run's
// stdout follows O1 with root `node_modules`, up to 200,000 entries. A
// symlink is accepted only when its link name is relative and, resolved
// against its parent's real path, stays inside `node_modules/`; an entry
// whose path passes through a symlink is refused, and so is a `.wh.` name
// segment. A link name is any number of leading `..` then plain segments, so
// its resolution never turns on another symlink. The launcher writes the
// layer anew from the accepted entries: files 0755 when the header's
// owner-execute bit is set and 0644 otherwise, directories 0755, owner 0:0,
// a fixed time, no extended attributes.

import { expect, it } from 'vitest';
import { writeLayer } from '../../packages/core-sandbox/src/layer-writer.ts';
import {
  OUTPUT_CAP,
  readOutput,
  UstarReader,
} from '../../packages/core-sandbox/src/ustar-reader.ts';
import { dir, file, header, symlink, tar } from './ustar-fixture.ts';

const refused = (why: string) => ({ ok: false, reason: 'output refused', why });
const prepare = (...chunks: Uint8Array[]) => readOutput('prepare', OUTPUT_CAP.S2, ...chunks);
const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const MODULES = tar(
  dir('node_modules'),
  dir('node_modules/.bin'),
  dir('node_modules/.pnpm'),
  dir('node_modules/.pnpm/a@1.0.0'),
  dir('node_modules/.pnpm/a@1.0.0/node_modules'),
  dir('node_modules/.pnpm/a@1.0.0/node_modules/a'),
  file('node_modules/.pnpm/a@1.0.0/node_modules/a/cli.js', '#!/usr/bin/env node', {
    mode: '0000775\0',
  }),
  file('node_modules/.pnpm/a@1.0.0/node_modules/a/index.js', 'export {}'),
  symlink('node_modules/a', '.pnpm/a@1.0.0/node_modules/a'),
  symlink('node_modules/.bin/a', '../.pnpm/a@1.0.0/node_modules/a/cli.js'),
  dir('node_modules/@scope'),
  symlink('node_modules/@scope/b+c', '../a'),
);

it('reads a pnpm-shaped node_modules with its symlinks and execute bits', () => {
  const read = prepare(MODULES);
  expect(read).toMatchObject({ ok: true });
  if (!read.ok) return;
  expect(read.entries.map((entry) => [entry.type, entry.name])).toHaveLength(12);
  expect(read.entries).toContainEqual({
    type: 'file',
    name: 'node_modules/.pnpm/a@1.0.0/node_modules/a/cli.js',
    data: ascii('#!/usr/bin/env node'),
    executable: true,
  });
  expect(read.entries).toContainEqual({
    type: 'file',
    name: 'node_modules/.pnpm/a@1.0.0/node_modules/a/index.js',
    data: ascii('export {}'),
    executable: false,
  });
  expect(read.entries).toContainEqual({
    type: 'symlink',
    name: 'node_modules/.bin/a',
    link: '../.pnpm/a@1.0.0/node_modules/a/cli.js',
  });
});

it('holds each grammar to its own root', () => {
  expect(prepare(tar(dir('dist')))).toEqual(refused('tar name'));
  expect(readOutput('build', OUTPUT_CAP.S1, tar(dir('node_modules')))).toEqual(refused('tar name'));
  expect(prepare(tar(file('node_modules', 'x')))).toEqual(refused('tar type'));
  expect(prepare(tar(symlink('node_modules', 'x')))).toEqual(refused('tar type'));
});

it('reads the owner-execute bit from an octal mode, and refuses a mode that is not octal', () => {
  const mode = (value: string) =>
    prepare(tar(dir('node_modules'), file('node_modules/f', 'x', { mode: value })));
  const executable = (value: string) => {
    const read = mode(value);
    return read.ok ? read.entries[1]?.type === 'file' && read.entries[1].executable : read;
  };
  expect(executable('0000100\0')).toBe(true);
  expect(executable('0004711\0')).toBe(true);
  expect(executable('0000677\0')).toBe(false);
  expect(executable('0000644 ')).toBe(false);
  for (const value of ['0000x44\0', ' 000644\0', '\0\0\0\0\0\0\0\0', '00006448']) {
    expect(mode(value), value).toEqual(refused('tar mode'));
  }
});

it('refuses a symlink whose link name is absolute, empty or not a plain relative path', () => {
  const linked = (link: string) =>
    prepare(tar(dir('node_modules'), dir('node_modules/a'), symlink('node_modules/a/l', link)));
  for (const link of [
    '/etc/passwd',
    '',
    './x',
    'x/../y',
    'x/./y',
    'x/',
    'x//y',
    '../x/..',
    '..',
    '../..',
    'bad name',
    'café',
    'x\\y',
  ]) {
    expect(linked(link), link).toEqual(refused('tar link'));
  }
  for (const link of ['x', '../x', '.x', '...', '../.pnpm/a@1/b']) {
    expect(linked(link), link).toMatchObject({ ok: true });
  }
});

it('refuses a symlink that resolves outside node_modules from its parent', () => {
  const at = (parent: string, link: string) => {
    const parents = parent.split('/').map((_, n, all) => dir(all.slice(0, n + 1).join('/')));
    return prepare(tar(...parents, symlink(`${parent}/l`, link)));
  };
  expect(at('node_modules', '../x')).toEqual(refused('tar link'));
  expect(at('node_modules/.bin', '../../x')).toEqual(refused('tar link'));
  expect(at('node_modules/.bin', '../../node_modules/x')).toEqual(refused('tar link'));
  expect(at('node_modules/a/b/c', '../../../../etc')).toEqual(refused('tar link'));
  expect(at('node_modules/a/b/c', '../../../x')).toMatchObject({ ok: true });
  expect(at('node_modules', 'x')).toMatchObject({ ok: true });
});

it('refuses a symlink with a size or a link name past the field', () => {
  expect(prepare(tar(dir('node_modules'), symlink('node_modules/l', 'x', { size: 1 })))).toEqual(
    refused('tar size'),
  );
  const full = 'x'.repeat(100);
  expect(prepare(tar(dir('node_modules'), symlink('node_modules/l', full)))).toMatchObject({
    ok: true,
  });
});

it('refuses an entry whose path passes through a symlink', () => {
  expect(
    prepare(
      tar(
        dir('node_modules'),
        dir('node_modules/a'),
        symlink('node_modules/l', 'a'),
        file('node_modules/l/x', 'y'),
      ),
    ),
  ).toEqual(refused('tar parent'));
  expect(
    prepare(tar(dir('node_modules'), symlink('node_modules/l', 'a'), dir('node_modules/l/d'))),
  ).toEqual(refused('tar parent'));
});

it('refuses a whiteout name segment', () => {
  for (const name of ['node_modules/.wh.a', 'node_modules/.wh..wh..opq', 'node_modules/d/.wh.x']) {
    expect(prepare(tar(dir('node_modules'), dir('node_modules/d'), file(name, ''))), name).toEqual(
      refused('tar name'),
    );
  }
  expect(prepare(tar(dir('node_modules'), dir('node_modules/.wh.d')))).toEqual(refused('tar name'));
  expect(prepare(tar(dir('node_modules'), file('node_modules/a.wh.b', '')))).toMatchObject({
    ok: true,
  });
  expect(prepare(tar(dir('node_modules'), file('node_modules/.whx', '')))).toMatchObject({
    ok: true,
  });
});

it('holds a prepare to 200,000 entries', () => {
  const reader = new UstarReader('prepare', OUTPUT_CAP.S2);
  reader.push(dir('node_modules'));
  for (let n = 1; n < 200_000; n += 1) reader.push(header({ name: `node_modules/${n}` }));
  expect(reader.end()).toEqual(refused('tar end'));
  reader.push(header({ name: 'node_modules/last' }));
  expect(reader.end()).toEqual(refused('too many entries'));
});

it('writes the layer anew: fixed modes, owner 0:0, a fixed time, no extended headers', () => {
  const read = prepare(MODULES);
  if (!read.ok) throw new Error('fixture refused');
  const layer = Buffer.concat(writeLayer(read.entries));
  const again = prepare(layer);
  expect(again).toEqual(read);
  expect(Buffer.concat(writeLayer(again.ok ? again.entries : []))).toEqual(layer);

  const headers: Buffer[] = [];
  for (let at = 0; at + 512 <= layer.length - 1024;) {
    const block = layer.subarray(at, at + 512);
    headers.push(block);
    const size = Number.parseInt(text(block.subarray(124, 135)), 8);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  expect(headers).toHaveLength(12);
  const field = (block: Buffer, at: number, length: number) =>
    text(block.subarray(at, at + length)).replace(/\0+$/u, '');
  for (const block of headers) {
    const type = field(block, 156, 1);
    const name = field(block, 0, 100);
    expect(['0', '5', '2'], name).toContain(type);
    const mode = field(block, 100, 8);
    if (type === '5') expect(mode, name).toBe('0000755');
    if (type === '2') expect(mode, name).toBe('0000777');
    if (type === '0') expect(mode, name).toBe(name.endsWith('cli.js') ? '0000755' : '0000644');
    expect(field(block, 108, 8)).toBe('0000000');
    expect(field(block, 116, 8)).toBe('0000000');
    expect(field(block, 136, 12)).toBe('00000000000');
    expect(field(block, 265, 32)).toBe('');
    expect(field(block, 297, 32)).toBe('');
  }
  expect(layer.subarray(-1024)).toEqual(Buffer.alloc(1024));
});

it('drops set-id and sticky bits and keeps only the owner-execute choice', () => {
  const read = prepare(
    tar(
      dir('node_modules'),
      file('node_modules/s', 'x', { mode: '0007777\0' }),
      file('node_modules/t', 'y', { mode: '0006666\0' }),
    ),
  );
  if (!read.ok) throw new Error('fixture refused');
  const layer = Buffer.concat(writeLayer(read.entries));
  expect(text(layer.subarray(512 + 100, 512 + 107))).toBe('0000755');
  expect(text(layer.subarray(512 * 3 + 100, 512 * 3 + 107))).toBe('0000644');
});

it('writes a name past 100 bytes through the prefix, and reads it back whole', () => {
  const top = `node_modules/${'d'.repeat(60)}`;
  const deep = `${top}/${'e'.repeat(60)}`;
  const read = prepare(
    tar(
      dir('node_modules'),
      dir(top),
      dir('e'.repeat(60), { prefix: top }),
      file('f'.repeat(90), 'x', { prefix: deep }),
    ),
  );
  if (!read.ok) throw new Error('fixture refused');
  expect(read.entries.map((entry) => entry.name)).toEqual([
    'node_modules',
    top,
    deep,
    `${deep}/${'f'.repeat(90)}`,
  ]);
  const layer = Buffer.concat(writeLayer(read.entries));
  expect(prepare(layer)).toEqual(read);
  expect(text(layer.subarray(512 * 2 + 345, 512 * 2 + 345 + top.length))).toBe(top);
  expect(text(layer.subarray(512 * 3 + 345, 512 * 3 + 345 + deep.length))).toBe(deep);
});
