// SPDX-License-Identifier: AGPL-3.0-only
//
// Custody's names the records package offers, in one place: the secrets and
// sealing. `open` is not among them (see `index.ts` here). The package's
// `index.ts` re-exports this file whole, which keeps that file under its line cap.

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
  generateSealingPair,
  loadSealingKey,
  seal,
  type Sealed,
  type SealingKey,
} from './index.ts';
