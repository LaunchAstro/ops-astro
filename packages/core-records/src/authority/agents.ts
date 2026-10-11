// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent of the business, as people name and direct it: an actor of kind
// `agent` (0002) with a display name and the person who owns it (migration
// 20261011115838). A task handed to an agent names this actor in its `agent`
// field, and the assignment stays until a person changes it.
//
// **Who directs an agent.** Its owner, or a holder of `agent:assign` over the
// whole business. Directing one is what `task.assign` asks before it hands a
// task to it; the task's own `task:assign` is the envelope's. A deactivated
// agent, or one of another business, is directed by nobody. Assigning starts
// nothing: a run asks for its own delegation.

import type { TenantQuery } from '../tenancy/database.ts';
import { effectiveGrants, type Subject } from './grants.ts';

/** The key that lets a person direct every agent of the business, not only their own. */
export const AGENT_ASSIGN: { readonly collection: 'agent'; readonly action: 'assign' } = {
  collection: 'agent',
  action: 'assign',
};

/** What an agent that was never named is called. */
export const UNNAMED_AGENT: string = 'AI agent';

/** The name an agent row reads as, its alias `a`. */
export const AGENT_NAME_SQL: string = `coalesce(a.display_name, '${UNNAMED_AGENT}')`;

export interface AgentChoice {
  readonly agentId: string;
  readonly name: string;
}

/** Whether the subjects hold `agent:assign` over the whole business right now. */
async function directsEveryAgent(tx: TenantQuery, subjects: readonly Subject[]): Promise<boolean> {
  const held = await effectiveGrants(tx, subjects, {
    ...AGENT_ASSIGN,
    scope: { kind: 'business', id: null },
  });
  return held.length > 0;
}

/** A person's grant subjects for a read: the person and their active acting identity. */
export async function personSubjects(
  tx: TenantQuery,
  personId: string,
): Promise<readonly Subject[]> {
  const actors = await tx.query<{ readonly id: string }>(
    `select id from public.actors
      where business_id = $1 and person_id = $2 and kind = 'person' and active`,
    [tx.businessId, personId],
  );
  return [
    { kind: 'person', id: personId },
    ...actors.map((actor) => ({ kind: 'actor' as const, id: actor.id })),
  ];
}

/** The active agents this person may direct, by name. */
export async function directableAgents(
  tx: TenantQuery,
  personId: string,
  subjects: readonly Subject[],
): Promise<readonly AgentChoice[]> {
  return await tx.query<AgentChoice>(
    `select a.id as "agentId", ${AGENT_NAME_SQL} as name from public.actors a
      where a.business_id = $1 and a.kind = 'agent' and a.active
        and (a.owner_person_id = $2 or $3)
      order by name, a.id`,
    [tx.businessId, personId, await directsEveryAgent(tx, subjects)],
  );
}

/**
 * Whether this person may hand work to the agent: `missing` when it is not an
 * active agent of this business, `not-yours` when it is and they may not
 * direct it. The row is held `for share`, so a rename or a deactivation of it
 * waits for the caller's transaction, and a grant's revocation waits on the
 * access lock the command envelope holds.
 */
export async function mayDirectAgent(
  tx: TenantQuery,
  personId: string,
  subjects: readonly Subject[],
  agentId: string,
): Promise<'yes' | 'missing' | 'not-yours'> {
  const rows = await tx.query<{ readonly owner: string | null }>(
    `select a.owner_person_id::text as owner from public.actors a
      where a.business_id = $1 and a.id = $2 and a.kind = 'agent' and a.active
      for share of a`,
    [tx.businessId, agentId],
  );
  const found = rows[0];
  if (found === undefined) return 'missing';
  if (found.owner === personId.toLowerCase()) return 'yes';
  return (await directsEveryAgent(tx, subjects)) ? 'yes' : 'not-yours';
}
