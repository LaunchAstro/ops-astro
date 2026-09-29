// SPDX-License-Identifier: AGPL-3.0-only
//
// The carried archive (ticket S0-3, part S0-3e; the restore drill's clean-host
// leg, recovery contract D-3). The store has no route from outside staging's
// network, so a drill on another host runs from a file: the newest sealed
// backup as the store handed it out (`restore-drill.mjs --export <file>`).
// `<file>` holds the sealed bytes exactly as the store holds them, so the
// operator's own `sha256sum <file>` prints the digest the store recorded when
// it took the backup; `<file>.json` holds the format, that time, the size and
// that digest. Both are ciphertext and facts only; the key never travels with
// them, it comes from the operator's own copy. On the other host
// (`--drill --archive <file>`) the file is checked against that digest, read
// in pieces into the drill's own copy, before anything is opened. The drill's
// receipt, carried back, is read here too (`--record <file>`) before the store
// records it.
//
// Nothing a refusal says names the file, its folder or anything in it.

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { RECEIPT_FIELDS } from './drill-receipt.mjs';

export const CARRIED_FORMAT = 'ops-astro-sealed-archive/2';

const ARCHIVE_KEYS = ['bytes', 'format', 'sha256', 'takenAt'];
const RECEIPT_KEYS = [...RECEIPT_FIELDS].toSorted();
const HEX64 = /^[0-9a-f]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const PIECE = 4 * 1024 * 1024;

export const digestOf = (body) => createHash('sha256').update(body).digest('hex');

const matches = (digest, recorded) =>
  HEX64.test(recorded) && timingSafeEqual(Buffer.from(digest), Buffer.from(recorded));

/** Removes each file it was handed that exists; a missing one is no fault. */
function removeAll(...files) {
  for (const file of files) {
    try {
      unlinkSync(file);
    } catch {
      // Not made, or gone already.
    }
  }
}

const refused = () =>
  new Error('the archive file could not be written: it exists, or its folder is not writable');

/**
 * Writes the archive the store handed out: `fetchInto(file)` writes its sealed
 * bytes into `file`, and `<file>.json` gets its time, size and recorded
 * digest. Mode 600, never over a file; on any failure neither is left.
 */
export async function writeCarried(file, fetchInto) {
  const facts = `${file}.json`;
  let fd;
  try {
    fd = openSync(facts, 'wx', 0o600);
  } catch {
    throw refused();
  }
  let archive;
  try {
    // The fetch makes `file` itself and removes it again if it fails.
    archive = await fetchInto(file);
  } catch (error) {
    closeSync(fd);
    removeAll(facts);
    throw ['EEXIST', 'EACCES', 'ENOENT', 'ELOOP'].includes(error?.code) ? refused() : error;
  }
  try {
    const { takenAt, bytes, sha256 } = archive;
    writeSync(fd, `${JSON.stringify({ format: CARRIED_FORMAT, takenAt, bytes, sha256 })}\n`);
  } catch {
    removeAll(facts, file);
    throw refused();
  } finally {
    closeSync(fd);
  }
  return archive;
}

/** One regular file, opened never through a link; `what` names it in a refusal. */
function openOwn(file, what) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) throw new Error('not a file');
    return fd;
  } catch {
    if (fd !== undefined) closeSync(fd);
    throw new Error(`the ${what} could not be read: it is missing, a link or not a file`);
  }
}

/** One regular file's text, never through a link. */
function readOwn(file, what) {
  const fd = openOwn(file, what);
  try {
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/** One JSON object on one line, with exactly `keys` as its own keys. */
function exactly(text, keys, what) {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  let parsed;
  try {
    if (lines.length !== 1) throw new Error('not one line');
    parsed = JSON.parse(lines[0]);
  } catch {
    throw new Error(`the ${what} is not one JSON line`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`the ${what} is not one JSON object`);
  }
  const own = Object.keys(parsed).toSorted();
  if (own.length !== keys.length || own.some((key, i) => key !== keys[i])) {
    throw new Error(`the ${what} does not have exactly its fields`);
  }
  return parsed;
}

/** The carried archive's facts, `<file>.json`, each of its fixed shape. */
function factsOf(file) {
  const held = exactly(readOwn(`${file}.json`, 'archive file'), ARCHIVE_KEYS, 'archive file');
  if (
    held.format !== CARRIED_FORMAT ||
    typeof held.takenAt !== 'string' ||
    !ISO.test(held.takenAt) ||
    typeof held.sha256 !== 'string' ||
    !HEX64.test(held.sha256) ||
    !Number.isSafeInteger(held.bytes) ||
    held.bytes < 1
  ) {
    throw new Error('the archive file is not a carried archive');
  }
  return held;
}

/**
 * The carried archive, checked against the digest the store recorded before
 * anything opens it, read in pieces; with `into`, copied as it is read into
 * that file (made here, mode 600), which the drill then opens, so what it
 * opens is what was checked. It answers what the drill fetches from the store.
 */
export function readCarried(file, into) {
  const held = factsOf(file);
  const fd = openOwn(file, 'archive file');
  let copy;
  try {
    if (fstatSync(fd).size !== held.bytes) {
      throw new Error('the archive does not match the digest the store recorded');
    }
    if (into !== undefined) copy = openSync(into, 'wx', 0o600);
    const whole = createHash('sha256');
    const piece = Buffer.alloc(PIECE);
    let read = 0;
    for (let got = readSync(fd, piece); got > 0; got = readSync(fd, piece)) {
      whole.update(piece.subarray(0, got));
      if (copy !== undefined) writeSync(copy, piece, 0, got);
      read += got;
    }
    if (read !== held.bytes || !matches(whole.digest('hex'), held.sha256)) {
      throw new Error('the archive does not match the digest the store recorded');
    }
  } catch (error) {
    if (copy !== undefined) {
      closeSync(copy);
      copy = undefined;
      removeAll(into);
    }
    throw error;
  } finally {
    closeSync(fd);
    if (copy !== undefined) closeSync(copy);
  }
  return { takenAt: held.takenAt, sha256: held.sha256, bytes: held.bytes };
}

const isInteger = (v) => Number.isInteger(v);
const orNull = (test) => (v) => v === null || test(v);
const isText = (v) => typeof v === 'string';
const isTime = (v) => typeof v === 'string' && ISO.test(v);

/** Each field's shape; the store checks the rest (stage names, timings, majors). */
const RECEIPT_SHAPE = {
  action: (v) => v === 'restore drill recorded',
  outcome: (v) => v === 'pending' || v === 'failed',
  stage: orNull(isText),
  at: isTime,
  target: isText,
  productionMajor: isInteger,
  sourceMajor: orNull(isInteger),
  targetMajor: orNull(isInteger),
  archiveTakenAt: isTime,
  tables: orNull(isInteger),
  readAs: orNull(isText),
  timings: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  lastTestedRestore: (v) => v === null,
  business: isText,
  operator: (v) => typeof v === 'string' && ID.test(v),
  ranOn: (v) => v === 'carried archive',
  archiveDigest: orNull((v) => typeof v === 'string' && HEX64.test(v)),
};

/**
 * A carried drill's receipt, as the operator who ran it brings it back: one
 * whole receipt of a drill on a carried archive, not yet recorded, theirs.
 */
export function readCarriedReceipt(file, operator) {
  const receipt = exactly(readOwn(file, 'receipt file'), RECEIPT_KEYS, 'receipt');
  for (const field of RECEIPT_KEYS) {
    if (!RECEIPT_SHAPE[field](receipt[field])) {
      throw new Error(`the receipt's ${field} is not one a carried drill writes`);
    }
  }
  if (receipt.operator !== operator) {
    throw new Error(
      'the receipt is of another person: only the operator who ran it brings it back',
    );
  }
  return receipt;
}
