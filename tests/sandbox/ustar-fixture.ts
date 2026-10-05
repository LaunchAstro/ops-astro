// SPDX-License-Identifier: AGPL-3.0-only
//
// Builds ustar headers field by field for the output grammar's corpus, so a
// case can set any field to a hostile value. Defaults make a valid O1 entry.

export type Header = {
  readonly name: string;
  readonly prefix?: string;
  /** The type byte, such as `0`, `5` or `2`, or `\0`. */
  readonly type?: string;
  readonly size?: number;
  /** The size field's 12 bytes, in place of `size`'s octal. */
  readonly sizeField?: Uint8Array;
  readonly mode?: string;
  readonly link?: string;
  readonly magic?: string;
  readonly version?: string;
  /** The checksum field's 8 bytes, in place of the right one. */
  readonly checksumField?: Uint8Array;
  /** Writes bytes at an offset after the other fields, before the checksum. */
  readonly poke?: readonly (readonly [number, Uint8Array])[];
};

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

const put = (block: Uint8Array, at: number, bytes: Uint8Array): void => {
  block.set(bytes, at);
};

export const octal = (value: number, width: number): Uint8Array =>
  ascii(`${value.toString(8).padStart(width - 1, '0')}\0`);

/** The unsigned byte sum with the checksum field read as spaces. */
export function checksumOf(block: Uint8Array): number {
  let sum = 8 * 32;
  for (let at = 0; at < 512; at += 1) if (at < 148 || at >= 156) sum += block[at] ?? 0;
  return sum;
}

export function header(fields: Header): Uint8Array {
  const block = new Uint8Array(512);
  put(block, 0, ascii(fields.name));
  put(block, 100, ascii(fields.mode ?? '0000644\0'));
  put(block, 108, octal(1000, 8));
  put(block, 116, octal(1000, 8));
  put(block, 124, fields.sizeField ?? octal(fields.size ?? 0, 12));
  put(block, 136, octal(1_700_000_000, 12));
  put(block, 156, ascii(fields.type ?? '0'));
  put(block, 157, ascii(fields.link ?? ''));
  put(block, 257, ascii(fields.magic ?? 'ustar\0'));
  put(block, 263, ascii(fields.version ?? '00'));
  put(block, 265, ascii('builder'));
  put(block, 297, ascii('builder'));
  put(block, 345, ascii(fields.prefix ?? ''));
  for (const [at, bytes] of fields.poke ?? []) put(block, at, bytes);
  put(
    block,
    148,
    fields.checksumField ?? ascii(`${checksumOf(block).toString(8).padStart(6, '0')}\0 `),
  );
  return block;
}

const padded = (body: Uint8Array): Uint8Array => {
  const out = new Uint8Array(Math.ceil(body.length / 512) * 512);
  out.set(body);
  return out;
};

export const dir = (name: string, fields: Partial<Header> = {}): Uint8Array =>
  header({ name: name.endsWith('/') ? name : `${name}/`, type: '5', mode: '0000755\0', ...fields });

export function file(
  name: string,
  body: string | Uint8Array,
  fields: Partial<Header> = {},
): Uint8Array {
  const bytes = typeof body === 'string' ? ascii(body) : body;
  return Buffer.concat([header({ name, size: bytes.length, ...fields }), padded(bytes)]);
}

export const symlink = (name: string, link: string, fields: Partial<Header> = {}): Uint8Array =>
  header({ name, type: '2', link, mode: '0000777\0', ...fields });

/** A header field run filled with one byte, for `poke`. */
export const filled = (at: number, length: number, byte = 0x7a): [number, Uint8Array] => [
  at,
  new Uint8Array(length).fill(byte),
];

export const END: Uint8Array = new Uint8Array(1024);

export const tar = (...parts: readonly Uint8Array[]): Uint8Array => Buffer.concat([...parts, END]);
