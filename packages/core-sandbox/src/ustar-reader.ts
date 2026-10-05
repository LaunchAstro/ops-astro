// SPDX-License-Identifier: AGPL-3.0-only
//
// A run's output (docs/plan/sandbox-contract.md, section 7): one ustar
// stream read in memory as a closed grammar, never extracted to disk. O1
// (`build`) takes files and directories under `dist`, at most 5,000
// entries; O2 (`prepare`) takes the same under `node_modules`, at most
// 200,000, plus symlinks that stay inside it, and no `.wh.` segment.
//
// The reader judges each byte as it arrives and keeps its first refusal,
// so a refusal for the size cap means every earlier byte passed and one
// byte went past the cap (F1's `output` crossing). A header or end block
// the cap cuts is read whole first, at most 511 bytes past the cap into
// the fixed block buffer, and judged as a larger cap would judge it, so
// the cap never hides a fault in it. A file's bytes are kept
// in one buffer that doubles as they arrive, never past the declared size
// or what the cap still lets arrive, and copied, so the caller may reuse its chunk. Every header byte is
// read: the pad and device fields hold only zeros or octal, and a name
// field is never empty, so an entry's last segment fits the name field. Mode, owner and time are never read, except a
// `prepare` file's owner-execute bit, which O2's layer rewrite keeps.
//
// A symlink's link name is any number of leading `..` then plain segments,
// read against its parent, which is always a directory entry: so where it
// points never turns on another symlink, earlier or later.

import type { Refused, Why } from './refusal.ts';

export type OutputGrammar = 'build' | 'prepare';

export type TarEntry =
  | {
      readonly type: 'file';
      readonly name: string;
      readonly data: Uint8Array;
      readonly executable: boolean;
    }
  | { readonly type: 'directory'; readonly name: string }
  | { readonly type: 'symlink'; readonly name: string; readonly link: string };

export type OutputRead = { readonly ok: true; readonly entries: readonly TarEntry[] } | Refused;

/** B6's output caps, in bytes of the stream. */
export const OUTPUT_CAP = { S0: 1_000_000, S1: 50_000_000, S2: 1_000_000_000 } as const;

const RULES = {
  build: { root: 'dist', entries: 5_000, symlinks: false },
  prepare: { root: 'node_modules', entries: 200_000, symlinks: true },
} as const;

const BLOCK = 512;
/** A file's first buffer; it doubles as bytes arrive, within the declared size and the cap. */
const FIRST_BUFFER = 64 * 1024;
const MAX_NAME = 255;
const SEGMENT = /^[A-Za-z0-9._~@+-]+$/u;
// `ustar\0` then `00`.
const MAGIC = [0x75, 0x73, 0x74, 0x61, 0x72, 0x00, 0x30, 0x30];
const TYPES = { 0x30: 'file', 0x35: 'directory', 0x32: 'symlink' } as const;

const refusal = (why: Why): Refused => ({ ok: false, reason: 'output refused', why });

const isTerminator = (byte: number): boolean => byte === 0 || byte === 0x20;

/** An octal number: one or more digits, then NUL or space to the field's end. */
function readOctal(field: Uint8Array): number | null {
  const digits = field.findIndex((byte) => byte < 0x30 || byte > 0x37);
  if (digits <= 0 || !field.subarray(digits).every((byte) => isTerminator(byte))) return null;
  return field.subarray(0, digits).reduce((value, byte) => value * 8 + byte - 0x30, 0);
}

/** A text field: bytes up to the first NUL, then only NULs. Each byte one code unit. */
function readText(field: Uint8Array): string | null {
  const end = field.indexOf(0);
  if (end !== -1 && field.subarray(end).some((byte) => byte !== 0)) return null;
  return String.fromCodePoint(...field.subarray(0, end === -1 ? field.length : end));
}

/** A device field: all NUL, or octal. Go's tar refuses any other bytes there. */
const isDevice = (field: Uint8Array): boolean =>
  field.every((byte) => byte === 0) || readOctal(field) !== null;

const plain = (segment: string): boolean =>
  SEGMENT.test(segment) && segment !== '.' && segment !== '..';

type State =
  | { readonly at: 'header' }
  | {
      readonly at: 'data';
      readonly entry: Omit<Extract<TarEntry, { type: 'file' }>, 'data'>;
      readonly size: number;
      data: Uint8Array;
      fill: number;
      padding: number;
    }
  | { readonly at: 'padding'; left: number }
  | { readonly at: 'zero' }
  | { readonly at: 'ended' };

export class UstarReader {
  readonly grammar: OutputGrammar;
  readonly cap: number;
  private readonly rules: (typeof RULES)[OutputGrammar];
  private readonly block = new Uint8Array(BLOCK);
  private blockFill = 0;
  private bytes = 0;
  private state: State = { at: 'header' };
  private readonly entries: TarEntry[] = [];
  private readonly kinds = new Map<string, TarEntry['type']>();
  private readonly folded = new Set<string>();
  private refused: Refused | null = null;

  constructor(grammar: OutputGrammar, cap: number) {
    this.grammar = grammar;
    this.cap = cap;
    this.rules = RULES[grammar];
  }

  push(...chunks: readonly Uint8Array[]): void {
    for (const chunk of chunks) this.read(chunk);
  }

  private read(chunk: Uint8Array): void {
    let at = 0;
    while (at < chunk.length && this.refused === null) {
      if (this.bytes >= this.cap && this.blockFill === 0) {
        this.refused = refusal('too large');
        return;
      }
      // Past the cap, only the rest of a block the cap cut.
      const room = this.bytes >= this.cap ? BLOCK - this.blockFill : this.cap - this.bytes;
      const take = Math.min(chunk.length - at, room, this.wanted());
      this.bytes += take;
      this.refused = this.take(chunk.subarray(at, at + take));
      at += take;
    }
  }

  private wanted(): number {
    const state = this.state;
    if (state.at === 'data') return state.size - state.fill;
    if (state.at === 'padding') return state.left;
    if (state.at === 'ended') return 1;
    return BLOCK - this.blockFill;
  }

  private take(bytes: Uint8Array): Refused | null {
    const state = this.state;
    if (state.at === 'ended') return refusal('tar end');
    if (state.at === 'padding') {
      if (bytes.some((byte) => byte !== 0)) return refusal('tar block');
      state.left -= bytes.length;
      if (state.left === 0) this.state = { at: 'header' };
      return null;
    }
    if (state.at === 'data') {
      if (state.fill + bytes.length > state.data.length) {
        // Never past the declared size, nor past what the cap still lets arrive.
        const most = Math.min(state.size, state.fill + bytes.length + (this.cap - this.bytes));
        const grown = new Uint8Array(Math.min(most, 2 * (state.fill + bytes.length)));
        grown.set(state.data.subarray(0, state.fill));
        state.data = grown;
      }
      state.data.set(bytes, state.fill);
      state.fill += bytes.length;
      if (state.fill === state.size) {
        this.entries.push({ ...state.entry, data: state.data });
        this.afterData(state.padding);
      }
      return null;
    }
    this.block.set(bytes, this.blockFill);
    this.blockFill += bytes.length;
    if (this.blockFill < BLOCK) return null;
    this.blockFill = 0;
    return this.atBlock();
  }

  private afterData(padding: number): void {
    this.state = padding === 0 ? { at: 'header' } : { at: 'padding', left: padding };
  }

  private atBlock(): Refused | null {
    if (this.block.every((byte) => byte === 0)) {
      this.state = this.state.at === 'zero' ? { at: 'ended' } : { at: 'zero' };
      return null;
    }
    if (this.state.at === 'zero') return refusal('tar end');
    return this.header(this.block);
  }

  private header(block: Uint8Array): Refused | null {
    let sum = 8 * 0x20;
    for (let at = 0; at < BLOCK; at += 1) if (at < 148 || at >= 156) sum += block[at] ?? 0;
    if (readOctal(block.subarray(148, 156)) !== sum) return refusal('tar checksum');
    if (MAGIC.some((byte, at) => block[257 + at] !== byte)) return refusal('tar magic');
    if (!isDevice(block.subarray(329, 337)) || !isDevice(block.subarray(337, 345))) {
      return refusal('tar block');
    }
    if (block.subarray(500, BLOCK).some((byte) => byte !== 0)) return refusal('tar block');

    const type = TYPES[block[156] as keyof typeof TYPES] as TarEntry['type'] | undefined;
    if (type === undefined || (type === 'symlink' && !this.rules.symlinks)) {
      return refusal('tar type');
    }
    const size = readOctal(block.subarray(124, 136));
    if (size === null || (type !== 'file' && size !== 0)) return refusal('tar size');
    let executable = false;
    if (type === 'file' && this.grammar === 'prepare') {
      const mode = readOctal(block.subarray(100, 108));
      if (mode === null) return refusal('tar mode');
      executable = (mode & 0o100) !== 0;
    }

    const name = this.name(block, type);
    if (typeof name !== 'string') return name;
    const link = readText(block.subarray(157, 257));
    if (link === null || (type !== 'symlink' && link !== '')) return refusal('tar link');
    if (type === 'symlink' && !this.staysInside(name, link)) return refusal('tar link');
    if (this.entries.length === this.rules.entries) return refusal('too many entries');

    this.kinds.set(name, type);
    this.folded.add(name.toLowerCase());
    if (type !== 'file') {
      this.entries.push(type === 'symlink' ? { type, name, link } : { type, name });
      this.state = { at: 'header' };
      return null;
    }
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;
    if (size === 0) {
      this.entries.push({ type, name, data: new Uint8Array(), executable });
      this.afterData(padding);
    } else {
      const entry = { type, name, executable } as const;
      const data = new Uint8Array(Math.max(0, Math.min(size, FIRST_BUFFER, this.cap - this.bytes)));
      this.state = { at: 'data', entry, size, data, fill: 0, padding };
    }
    return null;
  }

  /** The entry's canonical name, or the refusal for it. */
  private name(block: Uint8Array, type: TarEntry['type']): string | Refused {
    const name = readText(block.subarray(0, 100));
    const prefix = readText(block.subarray(345, 500));
    if (name === null || prefix === null || name === '') return refusal('tar name');
    let path = prefix === '' ? name : `${prefix}/${name}`;
    if (path.length > MAX_NAME) return refusal('tar name');
    if (type === 'directory' && path.endsWith('/')) path = path.slice(0, -1);
    const [root, ...rest] = path.split('/');
    if (root !== this.rules.root || !rest.every((segment) => plain(segment)))
      return refusal('tar name');
    if (this.grammar === 'prepare' && rest.some((segment) => segment.startsWith('.wh.'))) {
      return refusal('tar name');
    }
    if (rest.length === 0 && type !== 'directory') return refusal('tar type');
    if (this.folded.has(path.toLowerCase())) return refusal('tar duplicate');
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (rest.length > 0 && this.kinds.get(parent) !== 'directory') return refusal('tar parent');
    return path;
  }

  /** Leading `..` segments that stay below the root, then at least one plain segment. */
  private staysInside(name: string, link: string): boolean {
    const segments = link.split('/');
    let up = 0;
    while (segments[up] === '..') up += 1;
    const down = segments.slice(up);
    const parentDepth = name.split('/').length - 1;
    return down.length > 0 && down.every((segment) => plain(segment)) && up < parentDepth;
  }

  end(): OutputRead {
    if (this.refused !== null) return this.refused;
    // A stream that stops inside a block ends as `tar end`, past the cap or not.
    if (this.bytes > this.cap && this.blockFill === 0) return refusal('too large');
    if (this.state.at !== 'ended') return refusal('tar end');
    return { ok: true, entries: this.entries };
  }
}

export function readOutput(
  grammar: OutputGrammar,
  cap: number,
  ...chunks: readonly Uint8Array[]
): OutputRead {
  const reader = new UstarReader(grammar, cap);
  reader.push(...chunks);
  return reader.end();
}
