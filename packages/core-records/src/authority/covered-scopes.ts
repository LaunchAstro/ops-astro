// SPDX-License-Identifier: AGPL-3.0-only
//
// Where a caller's grants reach, for a list read that filters inside its own
// statement (MP-6-4). `readableScope` works it out, the map rule included.

import type { TenantQuery } from '../tenancy/database.ts';
import type { Action, Subject } from './grants.ts';
import { readableScope, type ReadableScope } from './readable-scope.ts';

/**
 * Where the caller holds this collection and action right now: the whole
 * business, or the records its record-scoped grants reach, with a granted
 * map's tickets for `task:read` (W12). A list read hands both to its own query, so the
 * rows it returns are filtered by the caller's grant inside the statement
 * that reads them. A subject held within ticked keys (an agent credential) is
 * asked only of those (`askedFor`).
 */
export type CoveredScopes = ReadableScope;

export async function coveredScopes(
  tx: TenantQuery,
  subjects: readonly Subject[],
  request: { readonly collection: string; readonly action: Action },
): Promise<CoveredScopes> {
  return await readableScope(tx, subjects, request.collection, request.action);
}
