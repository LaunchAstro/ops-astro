// SPDX-License-Identifier: AGPL-3.0-only
//
// C60 (CS-7.40): the client privacy check's shape, not built yet. Both checks
// let everything through until the settings exist on the client record, so
// the named C60 tests show red for their own reasons.

import type { TenantQuery } from '../tenancy/database.ts';

export type ClientUse =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | 'CLIENT_MODEL_USE_OFF'
        | 'CLIENT_NO_AGENT_EDITS'
        | 'LOCAL_MODEL_REQUIRED'
        | 'PROVIDER_NOT_ASSESSED';
    };

/** Whether this client's material may go to `provider` now. Not built: allows all. */
export async function checkClientModelUse(
  _tx: TenantQuery,
  _clientId: string,
  _provider: string,
): Promise<ClientUse> {
  return await Promise.resolve({ ok: true });
}

/** The one check an edit run calls (C77, C78). Not built: allows all. */
export async function checkClientEditRun(
  _tx: TenantQuery,
  _clientId: string,
  _provider: string,
): Promise<ClientUse> {
  return await Promise.resolve({ ok: true });
}
