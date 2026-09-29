// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01 skeleton for the red run: signatures only, built in the next commit.

export type CredentialKind = 'subscription' | 'api_key' | 'cloud_credential' | 'replay';

export type StorableKind = Exclude<CredentialKind, 'subscription'>;

export interface StoredCredential {
  readonly ref: string;
  readonly kind: StorableKind;
  /** The account that carries the call; none for `replay`. */
  readonly account: string | null;
  /** The one destination this credential may be sent to. */
  readonly destination: string;
  readonly header: 'authorization' | 'x-api-key';
  readonly value: string;
}

export type CredentialRefusal =
  'CREDENTIAL_NOT_STORABLE' | 'SESSION_TOKEN_REFUSED' | 'CREDENTIAL_MALFORMED';

export function parseCredentials(
  _entries: unknown,
):
  | { readonly ok: true; readonly credentials: ReadonlyMap<string, StoredCredential> }
  | { readonly ok: false; readonly code: CredentialRefusal; readonly at: number } {
  throw new Error('AW-01: not built');
}

export interface CarryContext {
  /** No person is present in their own session for this call. */
  readonly unattended: boolean;
  /** The person whose session presents the credential, if any. */
  readonly sessionPersonId: string | null;
  /** The person the run works for. */
  readonly workForPersonId: string | null;
  /** The installation the call's tenant belongs to, and the credential's own. */
  readonly tenantInstallation: string;
  readonly credentialInstallation: string;
}

export type CarryRefusal =
  'SUBSCRIPTION_UNATTENDED' | 'SUBSCRIPTION_OTHER_TENANT' | 'SUBSCRIPTION_NOT_OWN_WORK';

export function mayCarry(
  _kind: CredentialKind,
  _context: CarryContext,
): { readonly ok: true } | { readonly ok: false; readonly code: CarryRefusal } {
  throw new Error('AW-01: not built');
}
