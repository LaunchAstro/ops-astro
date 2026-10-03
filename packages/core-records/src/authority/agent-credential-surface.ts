// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent credential's names the records package offers, in one place: the
// key ring, issuing and revoking, and a credential's standing. `index.ts`
// re-exports this file whole, which keeps that file under its line cap.

export {
  configuredCredentialKeys,
  DERIVED_SCHEME,
  KEY_FILE_VARIABLE,
  LEGACY_SCHEME,
  withCredentialKeys,
  type CredentialKeysDecision,
  type DelegationCredentialKeys,
} from './credential-keys.ts';
export {
  CREDENTIAL_EXCLUDED_ACTIONS,
  CREDENTIAL_MAX_DAYS,
  deriveAgentCredential,
  issueAgentCredential,
  lockAgentCredential,
  revokeAgentCredential,
  type AgentCredential,
  type CredentialKey,
} from './agent-credentials.ts';
export {
  credentialSubject,
  isAgentCredentialForm,
  isAgentCredentialLive,
  recordCredentialRefusal,
  resolveAgentCredential,
  type CredentialStanding,
} from './agent-credential-standing.ts';
