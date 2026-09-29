// SPDX-License-Identifier: AGPL-3.0-only
//
// The backup's seal (ticket S0-3, line C8; TR-SEC-8, TR-S-B1-6). The backup job
// seals each dump to the operator's public key before it leaves the job, so the
// wire to the store and the store itself hold only ciphertext. The private key
// is the operator's, held apart from the store and from the job: whoever holds
// the job or the store cannot open a backup.
//
// One artefact is: 'OAB1', the wrapped key's length (2 bytes), a fresh AES-256
// key wrapped with RSA-OAEP (SHA-256), a 12-byte nonce, the 16-byte GCM tag,
// then the dump encrypted with AES-256-GCM. The header is bound in as
// additional data, so a cut or changed byte anywhere fails to open.

import {
  constants,
  createCipheriv,
  createDecipheriv,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';

const MAGIC = Buffer.from('OAB1');
const OAEP = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };

/** Seals `dump` to `publicKey` (PEM). */
export function sealArchive(dump, publicKey) {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const wrapped = publicEncrypt({ key: publicKey, ...OAEP }, key);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(wrapped.length);
  const header = Buffer.concat([MAGIC, length, wrapped, nonce]);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(dump), cipher.final()]);
  return Buffer.concat([header, cipher.getAuthTag(), body]);
}

/** Opens a sealed artefact with `privateKey` (PEM); throws on anything else. */
export function openArchive(sealed, privateKey) {
  if (sealed.length < 6 || !sealed.subarray(0, 4).equals(MAGIC)) throw new Error('not sealed');
  const end = 6 + sealed.readUInt16BE(4);
  const header = sealed.subarray(0, end + 12);
  if (sealed.length < header.length + 16) throw new Error('cut short');
  const key = privateDecrypt({ key: privateKey, ...OAEP }, sealed.subarray(6, end));
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(end, end + 12));
  decipher.setAAD(header);
  decipher.setAuthTag(sealed.subarray(header.length, header.length + 16));
  return Buffer.concat([decipher.update(sealed.subarray(header.length + 16)), decipher.final()]);
}
