// SPDX-License-Identifier: AGPL-3.0-only
//
// O2's layer rewrite (docs/plan/sandbox-contract.md, section 7): the
// launcher writes the `node_modules` image layer anew from the entries O2
// accepted, never from the run's bytes. A file is 0755 when its header's
// owner-execute bit was set and 0644 otherwise, a directory 0755, a
// symlink 0777; owner 0:0, time 0, no owner names and no extended headers.
// Entries are written in byte order of name, so the run's own order never
// reaches the layer (a parent sorts before its children). A name past 100
// bytes goes through the prefix at its last `/` that fits: the reader held
// each name to 255 bytes with a non-empty name field, so one always does.

import type { TarEntry } from './ustar-reader.ts';

const BLOCK = 512;
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const octal = (value: number, width: number): Uint8Array =>
  encode(`${value.toString(8).padStart(width - 1, '0')}\0`);

function split(name: string): { readonly prefix: string; readonly name: string } {
  if (name.length <= 100) return { prefix: '', name };
  const at = name.lastIndexOf('/', 155);
  if (at <= 0 || name.length - at - 1 > 100) throw new Error(`no ustar split for ${name}`);
  return { prefix: name.slice(0, at), name: name.slice(at + 1) };
}

const MODE = { directory: 0o755, symlink: 0o777 } as const;
const TYPE = { file: '0', directory: '5', symlink: '2' } as const;

function header(entry: TarEntry): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const parts = split(entry.name);
  const mode = entry.type === 'file' ? (entry.executable ? 0o755 : 0o644) : MODE[entry.type];
  block.set(encode(parts.name), 0);
  block.set(octal(mode, 8), 100);
  block.set(octal(0, 8), 108);
  block.set(octal(0, 8), 116);
  block.set(octal(entry.type === 'file' ? entry.data.length : 0, 12), 124);
  block.set(octal(0, 12), 136);
  block.set(encode(TYPE[entry.type]), 156);
  if (entry.type === 'symlink') block.set(encode(entry.link), 157);
  block.set(encode('ustar\u000000'), 257);
  block.set(encode(parts.prefix), 345);
  let sum = 8 * 0x20;
  for (const byte of block) sum += byte;
  block.set(encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
  return block;
}

/** The layer as tar blocks in byte order of name, ending in two zero blocks. */
export function writeLayer(entries: readonly TarEntry[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  const named = entries.map((entry) => ({ entry, name: Buffer.from(entry.name) }));
  named.sort((a, b) => Buffer.compare(a.name, b.name));
  for (const { entry } of named) {
    out.push(header(entry));
    if (entry.type !== 'file' || entry.data.length === 0) continue;
    out.push(entry.data);
    const padding = (BLOCK - (entry.data.length % BLOCK)) % BLOCK;
    if (padding > 0) out.push(new Uint8Array(padding));
  }
  out.push(new Uint8Array(2 * BLOCK));
  return out;
}
