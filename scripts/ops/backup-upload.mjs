// SPDX-License-Identifier: AGPL-3.0-only
//
// The store script for one backup archive (backup.mjs), built as the dump
// streams: the dump sealed in parts, then the archive completed with its size
// and digest as bound parameters, in one transaction.

import { createHash } from 'node:crypto';
import { bound, param, value } from './backup-store-reach.mjs';

const BACKUP_ROLE = 'ops_astro_backup';
// The store's part size (deploy/staging/backup-store.sql, backups.archive_parts).
const PART = 4 * 1024 * 1024;

/** The dump's pieces, whether `dump` answered them as a stream or as one buffer. */
async function* piecesOf(source) {
  if (Buffer.isBuffer(source)) yield source;
  else yield* source;
}

/**
 * The store script for one archive, as pieces: the dump, sealed as it
 * streams, in parts of `PART` bytes, then the archive completed with its size
 * and the sha256 of its whole ciphertext, in one transaction. `failure.stage`
 * names the step that failed if the dump or the seal throws.
 */
export async function* upload(source, seal, failure) {
  yield `set role ${BACKUP_ROLE};\nbegin;\n`;
  const whole = createHash('sha256');
  let [held, size, seq, bytes] = [[seal.header], seal.header.length, 0, 0];
  function* part(bytesOut) {
    whole.update(bytesOut);
    bytes += bytesOut.length;
    yield `select backups.add_part(${seq}, `;
    yield* value(bytesOut, 'bytea');
    yield ');\n';
    seq += 1;
  }
  function* flush(all) {
    // Whole parts only, until the end, when the last may be short.
    const under = all ? 0 : PART - 1;
    while (size > under) {
      const joined = Buffer.concat(held);
      const out = joined.subarray(0, PART);
      held = [joined.subarray(out.length)];
      size = joined.length - out.length;
      yield* part(out);
    }
  }
  const pieces = piecesOf(source)[Symbol.asyncIterator]();
  for (;;) {
    failure.stage = 'dump';
    // oxlint-disable-next-line no-await-in-loop -- one piece at a time is the point
    const next = await pieces.next();
    failure.stage = 'seal';
    if (next.done) break;
    held.push(seal.update(next.value));
    size += held.at(-1).length;
    failure.stage = null;
    yield* flush(false);
  }
  held.push(seal.final());
  size += held.at(-1).length;
  failure.stage = null;
  yield* flush(true);
  yield bound(`select backups.complete_archive(${param(1, 'bigint')}, ${param(2, 'text')})`, [
    bytes,
    whole.digest('hex'),
  ]);
  yield 'commit;\n';
  failure.bytes = bytes;
}
