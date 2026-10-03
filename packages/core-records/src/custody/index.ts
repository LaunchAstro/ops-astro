// SPDX-License-Identifier: AGPL-3.0-only
//
// Custody (C31). `open` is exported here for the broker and the custody
// conformance proof; the package index leaves it out, so application code
// that imports from the package cannot reach it.

export {
  clearSecret,
  isSecretStale,
  listSecrets,
  markSecretUsed,
  readSecret,
  setSecret,
  type SecretRow,
  type SecretScope,
  type SecretStale,
  type SecretWritten,
} from './secrets.ts';
export {
  generateSealingPair,
  loadSealingKey,
  open,
  seal,
  type Sealed,
  type SealingKey,
} from './sealing.ts';
