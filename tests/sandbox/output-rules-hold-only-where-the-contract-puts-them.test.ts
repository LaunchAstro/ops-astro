// SPDX-License-Identifier: AGPL-3.0-only
//
// O1 and O2 (docs/plan/sandbox-contract.md, section 7) differ by class, and
// each rule holds only where the contract puts it: a `.wh.` segment is
// refused in `prepare` output alone, and a mode field is read only for a
// `prepare` file's owner-execute bit, so a directory or symlink with any
// mode field passes. O2's layer rewrite splits every name it writes through
// the prefix; a name no split can hold is refused, never written short.

import { expect, it } from 'vitest';
import { writeLayer } from '../../packages/core-sandbox/src/layer-writer.ts';
import { OUTPUT_CAP, readOutput } from '../../packages/core-sandbox/src/ustar-reader.ts';
import { dir, file, symlink, tar } from './ustar-fixture.ts';

const build = (...chunks: Uint8Array[]) => readOutput('build', OUTPUT_CAP.S1, ...chunks);
const prepare = (...chunks: Uint8Array[]) => readOutput('prepare', OUTPUT_CAP.S2, ...chunks);

it('accepts a .wh. segment in a build, where only the prepare grammar refuses it', () => {
  const read = build(tar(dir('dist'), dir('dist/.wh.d'), file('dist/.wh.d/.wh.a', 'x')));
  expect(read).toMatchObject({ ok: true });
  expect(read.ok && read.entries.map((entry) => entry.name)).toEqual([
    'dist',
    'dist/.wh.d',
    'dist/.wh.d/.wh.a',
  ]);
});

it('ignores the mode field of a prepare directory and symlink, reading it only on a file', () => {
  const junk = { mode: 'zzzzzzz\0' };
  const read = prepare(
    tar(
      dir('node_modules'),
      dir('node_modules/a', junk),
      file('node_modules/a/f', 'x'),
      symlink('node_modules/a/l', 'f', junk),
    ),
  );
  expect(read).toMatchObject({ ok: true });
  expect(read.ok && read.entries.map((entry) => entry.type)).toEqual([
    'directory',
    'directory',
    'file',
    'symlink',
  ]);
});

it('refuses to write a layer name that no ustar prefix split can hold', () => {
  const data = new Uint8Array();
  const write = (name: string) => () =>
    writeLayer([{ type: 'file', name, data, executable: false }]);
  // The last segment is longer than the name field.
  expect(write(`node_modules/${'a'.repeat(101)}`)).toThrow('no ustar split');
  // The only slash is the first byte, so the prefix would be empty.
  expect(write(`/${'a'.repeat(100)}`)).toThrow('no ustar split');
  // A split that fits is written whole.
  expect(write(`node_modules/${'a'.repeat(100)}`)).not.toThrow();
});
