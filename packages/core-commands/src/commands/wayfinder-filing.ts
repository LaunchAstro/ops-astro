// SPDX-License-Identifier: AGPL-3.0-only
//
// Wayfinder's filing rule (WF-1, CS-15.9): a grilling or prototype ticket
// arriving on a map, created, moved or retyped there, is the map owner's,
// under task:decide. Moved whole from wayfinder.ts to keep it under the line
// limit; the rule is unchanged.

import { wayfinderFacts } from '../../../core-records/src/index.ts';
import type { TenantQuery, WayfinderFacts } from '../../../core-records/src/index.ts';
import type { CommandRefusal } from './refusal.ts';
import type { CommandContext } from './context.ts';
import { refuseUnlessOwner } from './wayfinder-owner.ts';

/**
 * A retype into grilling or prototype files the record on the map it sits
 * under, as a create or a move there would: the filing rule judges that map
 * too. A map nested under someone else's map is its creator's, so the
 * record's own rule alone would let a non-owner turn it into the outer map's
 * grilling or prototype ticket.
 */
export async function refuseRetypeOntoMap(
  tx: TenantQuery,
  context: CommandContext,
  recordId: string,
): Promise<CommandRefusal | undefined> {
  const rows = await tx.query<{ readonly parent: string | null }>(
    `select uuid_4 as parent from public.records where business_id = $1 and id = $2`,
    [tx.businessId, recordId],
  );
  const parentId = rows[0]?.parent ?? null;
  if (parentId === null) return undefined;
  // Parent held `for share` as its type is read: a retype in flight is seen.
  const parent = await wayfinderFacts(tx, parentId, true);
  if (parent?.type !== 'map') return undefined;
  return await refuseFilingOnMap(tx, context, parent);
}

/**
 * A grilling or prototype ticket arriving on a map, moved or created there:
 * `task:decide` and the map's owner, and a map with no owner recorded refuses.
 */
export async function refuseFilingOnMap(
  tx: TenantQuery,
  context: CommandContext,
  map: WayfinderFacts,
): Promise<CommandRefusal | undefined> {
  return await refuseUnlessOwner(
    tx,
    context,
    map,
    {
      decide: 'Filing a grilling or prototype ticket on a map needs task:decide.',
      owner: "Only the map's owner files a grilling or prototype ticket on the map.",
    },
    'refuse',
  );
}
