// SPDX-License-Identifier: AGPL-3.0-only
//
// O4's output digest (docs/plan/sandbox-contract.md, section 7): the
// sha256 of every entry of a build's output in byte order of name, each
// written as its type byte (`0` or `5`), the name's length (8 bytes,
// big-endian), the name, and for a file its size (8 bytes, big-endian) and
// its bytes. Mode, owner, time and the stream's own order never reach it.

import { createHash } from 'node:crypto';
import type { TarEntry } from './ustar-reader.ts';

const length8 = (value: number): Buffer => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(value));
  return out;
};

/** The digest of O1's entries, as 64 lowercase hex. */
export function outputDigest(entries: readonly TarEntry[]): string {
  const named = entries.map((entry) => ({ entry, name: Buffer.from(entry.name, 'utf8') }));
  named.sort((a, b) => Buffer.compare(a.name, b.name));
  const hash = createHash('sha256');
  for (const { entry, name } of named) {
    if (entry.type === 'symlink')
      throw new Error('O4 digests a build output, which has no symlink');
    hash.update(entry.type === 'file' ? '0' : '5');
    hash.update(length8(name.length));
    hash.update(name);
    if (entry.type === 'file') {
      hash.update(length8(entry.data.length));
      hash.update(entry.data);
    }
  }
  return hash.digest('hex');
}
