// SPDX-License-Identifier: AGPL-3.0-only
//
// C32: grants given and revoked on Settings ▸ Access. Not built yet.

import type { TenantQuery } from '../tenancy/database.ts';
import type { Decision } from './grants.ts';

export interface AccessGrant {
  readonly personId: string;
  readonly collection: string;
  readonly action: string;
  readonly clientId?: string | null;
}

export async function grantAccess(
  _tx: TenantQuery,
  _grant: AccessGrant,
  _actorId: string,
): Promise<Decision<string>> {
  throw new Error('C32: grantAccess is not built');
}

export async function revokeAccess(_tx: TenantQuery, _grantId: string): Promise<Decision<Date>> {
  throw new Error('C32: revokeAccess is not built');
}
