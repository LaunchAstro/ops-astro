// SPDX-License-Identifier: AGPL-3.0-only
//
// Wayfinder's owner rule (WF-1, CS-15.9): a map's grilling and prototype
// tickets are the map owner's, under `task:decide`. Its own module, so every
// command that closes a ticket asks it, `task.complete` included, without
// reaching the rest of the wayfinder commands.

import { checkAuthority, OWNER_TYPES, subjectsOf } from '../../../core-records/src/index.ts';
import type { TenantQuery, WayfinderFacts } from '../../../core-records/src/index.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import type { CommandContext } from './context.ts';

/** `task:decide` at the ticket, or at its map. */
async function holdsDecide(
  tx: TenantQuery,
  context: CommandContext,
  facts: WayfinderFacts,
): Promise<boolean> {
  const subjects = subjectsOf(context.session);
  const target = context.target?.id ?? null;
  for (const id of [target, facts.mapId].filter((x): x is string => x !== null)) {
    // At most two: the ticket, then its map.
    // oxlint-disable-next-line no-await-in-loop
    const held = await checkAuthority(tx, subjects, {
      collection: context.declaration.collection,
      action: 'decide',
      scope: { kind: 'record', id },
    });
    if (held.ok) return true;
  }
  return false;
}

/** What the owner rule says when it refuses: the decide line, then the owner line. */
export interface OwnerRuleFixes {
  readonly decide: string;
  readonly owner: string;
}

/**
 * The owner rule on a grilling, prototype or map ticket: `task:decide` at the
 * ticket or its map, and the map's owner. A map with no owner recorded passes
 * the owner half unless `ownerless` says to refuse it.
 */
export async function refuseUnlessOwner(
  tx: TenantQuery,
  context: CommandContext,
  facts: WayfinderFacts,
  fixes: OwnerRuleFixes,
  ownerless: 'pass' | 'refuse' = 'pass',
): Promise<CommandRefusal | undefined> {
  if (!(await holdsDecide(tx, context, facts))) {
    return refuseCommand('SCOPE_NOT_GRANTED', ['task:decide'], [fixes.decide]);
  }
  const owner = facts.mapOwner;
  if (owner === null && ownerless === 'pass') return undefined;
  if (owner !== context.session.personId) {
    return refuseCommand('SCOPE_NOT_GRANTED', ['map owner'], [fixes.owner]);
  }
  return undefined;
}

/**
 * A grilling or prototype ticket of a map is closed by its map's owner alone,
 * whichever command closes it: `task.complete`, `task.resolve` or
 * `task.close_out_of_scope`. Other tickets, maps and tasks on no map pass.
 */
export async function refuseUnlessOwnerCloses(
  tx: TenantQuery,
  context: CommandContext,
  facts: WayfinderFacts | undefined,
): Promise<CommandRefusal | undefined> {
  if (facts === undefined || facts.type === 'map' || facts.mapId === null) return undefined;
  if (!OWNER_TYPES.has(facts.type)) return undefined;
  return await refuseUnlessOwner(tx, context, facts, {
    decide: 'Closing a grilling or prototype ticket needs task:decide.',
    owner: "Only the map's owner closes a grilling or prototype ticket.",
  });
}
