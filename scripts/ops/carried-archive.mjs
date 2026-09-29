// SPDX-License-Identifier: AGPL-3.0-only
//
// The carried archive (ticket S0-3, part S0-3e; the restore drill's clean-host
// leg, recovery contract D-3). The store has no route from outside staging's
// network, so a drill on another host runs from a file: the newest sealed
// backup as the store handed it out, with the digest the store recorded when it
// took the backup (`restore-drill.mjs --export`). The file holds ciphertext
// only; the key never travels with it, it comes from the operator's own copy.
// On the other host (`--drill --archive <file>`) the body is checked against
// that digest before anything is opened. The drill's receipt, carried back, is
// read here too (`--record <file>`) before the store records it.
//
// Nothing a refusal says names the file, its folder or anything in it.

import { createHash, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { RECEIPT_FIELDS } from './drill-receipt.mjs';

export const CARRIED_FORMAT = 'ops-astro-sealed-archive/1';

const ARCHIVE_KEYS = ['body', 'format', 'sha256', 'takenAt'];
const RECEIPT_KEYS = [...RECEIPT_FIELDS].toSorted();
const HEX64 = /^[0-9a-f]{64}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;

export const digestOf = (body) => createHash('sha256').update(body).digest('hex');

const matches = (body, recorded) =>
  HEX64.test(recorded) && timingSafeEqual(Buffer.from(digestOf(body)), Buffer.from(recorded));

/**
 * Writes the archive the store handed out, as the store holds it: its time,
 * its recorded digest and its sealed bytes. Mode 600, never over a file.
 */
export function writeCarried(file, archive) {
  if (!matches(archive.body, archive.sha256)) {
    throw new Error('the archive does not match the digest the store recorded');
  }
  const text = JSON.stringify({
    format: CARRIED_FORMAT,
    takenAt: archive.takenAt,
    sha256: archive.sha256,
    body: archive.body.toString('base64'),
  });
  try {
    writeFileSync(file, `${text}\n`, { mode: 0o600, flag: 'wx' });
  } catch {
    throw new Error(
      'the archive file could not be written: it exists, or its folder is not writable',
    );
  }
}

/** One regular file's text, never through a link. */
function readOwn(file, what) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) throw new Error('not a file');
    return readFileSync(fd, 'utf8');
  } catch {
    throw new Error(`the ${what} could not be read: it is missing, a link or not a file`);
  } finally {
    if (fd !== undefined) closeSync(fd);
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

/**
 * The carried archive, checked against the digest the store recorded before
 * anything opens it. It answers what the drill fetches from the store.
 */
export function readCarried(file) {
  const held = exactly(readOwn(file, 'archive file'), ARCHIVE_KEYS, 'archive file');
  if (
    held.format !== CARRIED_FORMAT ||
    typeof held.takenAt !== 'string' ||
    !ISO.test(held.takenAt) ||
    typeof held.sha256 !== 'string' ||
    !HEX64.test(held.sha256) ||
    typeof held.body !== 'string' ||
    !BASE64.test(held.body)
  ) {
    throw new Error('the archive file is not a carried archive');
  }
  const body = Buffer.from(held.body, 'base64');
  if (!matches(body, held.sha256)) {
    throw new Error('the archive does not match the digest the store recorded');
  }
  return { takenAt: held.takenAt, body };
}

const isInteger = (v) => Number.isInteger(v);
const orNull = (test) => (v) => v === null || test(v);
const isText = (v) => typeof v === 'string';
const isTime = (v) => typeof v === 'string' && ISO.test(v);

/** Each field's shape; the store checks the rest (stage names, timings, majors). */
const RECEIPT_SHAPE = {
  action: (v) => v === 'restore drill recorded',
  outcome: (v) => v === 'passed' || v === 'failed',
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
