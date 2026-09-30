// SPDX-License-Identifier: AGPL-3.0-only
//
// The backup's seal (ticket S0-3, line C8; TR-SEC-8, TR-S-B1-6). The backup job
// seals each dump to the operator's public key before it leaves the job, so the
// wire to the store and the store itself hold only ciphertext. The private key
// is the operator's, held apart from the store and from the job: whoever holds
// the job or the store cannot open a backup.
//
// One artefact is: 'OAB2', the wrapped key's length (2 bytes), a fresh AES-256
// key wrapped with RSA-OAEP (SHA-256), a 12-byte nonce, then the dump encrypted
// with AES-256-GCM, then the 16-byte GCM tag. The header is bound in as
// additional data, so a cut or changed byte anywhere fails to open. The tag
// comes last so the job seals as the dump streams, in fixed memory (REV158S
// criterion 5); no archive in the earlier 'OAB1' order was ever kept.
//
// GCM releases plaintext before its tag is checked. So the drill opens a
// sealed file twice: first to check the tag, writing the plaintext nowhere
// (`checkSealedFile`), and only then again into the throwaway container's
// pg_restore (`openSealedFile`); the file is the drill's own, mode 600.

import {
  constants,
  createCipheriv,
  createDecipheriv,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import { closeSync, createReadStream, fstatSync, openSync, readSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('OAB2');
const OAEP = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };
const TAG = 16;

/**
 * A seal to `publicKey` (PEM) that takes the dump piece by piece: its header,
 * then `update` for each piece of the dump, then `final` for the tail and tag.
 */
export function sealer(publicKey) {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const wrapped = publicEncrypt({ key: publicKey, ...OAEP }, key);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(wrapped.length);
  const header = Buffer.concat([MAGIC, length, wrapped, nonce]);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG });
  cipher.setAAD(header);
  return {
    header,
    update: (piece) => cipher.update(piece),
    final: () => Buffer.concat([cipher.final(), cipher.getAuthTag()]),
  };
}

/** Seals `dump` to `publicKey` (PEM), whole. */
export function sealArchive(dump, publicKey) {
  const seal = sealer(publicKey);
  return Buffer.concat([seal.header, seal.update(dump), seal.final()]);
}

/** The header's length and a decipher for the body, from an artefact's first bytes. */
function opening(head, privateKey) {
  if (head.length < 6 || !head.subarray(0, 4).equals(MAGIC)) throw new Error('not sealed');
  const end = 6 + head.readUInt16BE(4);
  if (head.length < end + 12) throw new Error('cut short');
  const header = head.subarray(0, end + 12);
  const key = privateDecrypt({ key: privateKey, ...OAEP }, head.subarray(6, end));
  const decipher = createDecipheriv('aes-256-gcm', key, head.subarray(end, end + 12), {
    authTagLength: TAG,
  });
  decipher.setAAD(header);
  return { length: header.length, decipher };
}

/** Opens a sealed artefact, whole, with `privateKey` (PEM); throws on anything else. */
export function openArchive(sealed, privateKey) {
  const { length, decipher } = opening(sealed, privateKey);
  if (sealed.length < length + TAG) throw new Error('cut short');
  decipher.setAuthTag(sealed.subarray(-TAG));
  return Buffer.concat([decipher.update(sealed.subarray(length, -TAG)), decipher.final()]);
}

/** `count` bytes of `fd` from `position`, or fewer where the file ends. */
function readAt(fd, count, position) {
  const bytes = Buffer.alloc(count);
  return bytes.subarray(0, readSync(fd, bytes, 0, count, position));
}

/**
 * The plaintext of the sealed file `path`, as a stream read from the file in
 * pieces. It throws at once on a file that is not sealed or not to this key;
 * the stream fails at its end when the tag does not match.
 */
export function openSealedFile(path, privateKey) {
  const fd = openSync(path, 'r');
  let body;
  try {
    const size = fstatSync(fd).size;
    const lead = readAt(fd, 6, 0);
    const head = readAt(fd, lead.length < 6 ? 0 : 6 + lead.readUInt16BE(4) + 12, 0);
    const { length, decipher } = opening(lead.length < 6 ? lead : head, privateKey);
    if (size < length + TAG) throw new Error('cut short');
    decipher.setAuthTag(readAt(fd, TAG, size - TAG));
    body = { start: length, end: size - TAG - 1, decipher };
  } finally {
    closeSync(fd);
  }
  const source =
    body.end < body.start
      ? Readable.from([])
      : createReadStream(path, { start: body.start, end: body.end });
  source.on('error', (error) => body.decipher.destroy(error));
  return source.pipe(body.decipher);
}

/** Resolves once the sealed file `path` opens whole with `privateKey`; keeps no plaintext. */
export async function checkSealedFile(path, privateKey) {
  const nowhere = new Writable({ write: (_piece, _encoding, done) => done() });
  await pipeline(openSealedFile(path, privateKey), nowhere);
}
