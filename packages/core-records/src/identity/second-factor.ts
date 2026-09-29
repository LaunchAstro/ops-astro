// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';

export async function recordFactorEnrolled(
  _tx: TenantQuery,
  _factor: {
    readonly personId: string;
    readonly provider: string;
    readonly providerFactorId: string;
  },
): Promise<{ readonly id: string }> {
  return { id: randomUUID() };
}

export async function recordFactorVerified(
  _tx: TenantQuery,
  _factor: { readonly personId: string; readonly factorId: string },
): Promise<void> {}
