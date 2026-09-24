// SPDX-License-Identifier: AGPL-3.0-only
//
// Lease renewal on both entries, and the lease-seconds reader pickup shares.
// The person's renewal and the agent's (`heartbeatLease`, which the agent path
// reaches with the actor and delegation its credential resolved to) share
// `renewLease`. Split out when the one task-runtime module was divided
// (thermo review b282216, H2).

import type { TenantQuery } from '../tenancy/database.ts';
import { heartbeat, MAXIMUM_RENEWAL_SECONDS } from '../../../core-runtime/src/heartbeat.ts';
import type { CommandContext } from './context.ts';
import { isIdentifier } from './operands.ts';
import { fromReasoned, refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome, type Refused } from './outcome.ts';
import { personClaimant, type AgentClaimant } from './tasks-claimant.ts';

const DEFAULT_RENEWAL_SECONDS = 15 * 60;

/** What a caller sent as `leaseSeconds` is told, on either entry, for a route with this maximum. */
export function leaseSecondsFixes(maximum: number): readonly string[] {
  return [`Name a whole number of seconds from 1 to ${maximum}, or leave it out.`];
}

/**
 * A lease duration, read once for every route that takes one. Absent is the
 * route's documented default. Present is a whole number of seconds from 1 to
 * the route's maximum, and anything else, `null` included, is refused by name
 * (root ruling 2, ROOT-01a437a): a caller that sent something and got the
 * default back would believe the server had read what it sent.
 */
export function readLeaseSeconds(
  fields: { readonly leaseSeconds?: unknown },
  fallback: number,
  maximum: number,
): number | Refused {
  const seconds = fields.leaseSeconds;
  if (seconds === undefined) return fallback;
  if (
    typeof seconds !== 'number' ||
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    seconds > maximum
  ) {
    return refused(
      refuseCommand('FIELD_VALUE_INVALID', ['leaseSeconds'], leaseSecondsFixes(maximum)),
      { leaseSeconds: seconds },
    );
  }
  return seconds;
}

export interface RenewalFields {
  readonly leaseId: unknown;
  readonly fence: unknown;
  readonly leaseSeconds?: unknown;
}

/**
 * One renewal for both claimants: the operands read and refused here, the
 * lease renewed by `renew` under the claimant's own authority. The agent's
 * is `heartbeatLease` in `tasks-controls.ts`, with the delegation its
 * credential resolved to; the person's is `heartbeatOwnLease` below.
 */
export async function renewLease(
  fields: RenewalFields,
  renew: (lease: {
    readonly leaseId: string;
    readonly fence: number;
    readonly renewSeconds: number;
  }) => ReturnType<typeof heartbeat>,
): Promise<HandlerOutcome> {
  const seconds = readLeaseSeconds(fields, DEFAULT_RENEWAL_SECONDS, MAXIMUM_RENEWAL_SECONDS);
  if (typeof seconds !== 'number') return seconds;
  if (typeof fields.fence !== 'number' || !Number.isSafeInteger(fields.fence)) {
    return refused(
      refuseCommand('FIELD_VALUE_INVALID', ['fence'], ['Send the fence the pickup handed back.']),
    );
  }
  if (!isIdentifier(fields.leaseId)) {
    return refused(refuseCommand('LEASE_NOT_OWNED', [], NOT_THIS_CALLERS_LEASE));
  }
  const result = await renew({
    leaseId: fields.leaseId,
    fence: fields.fence,
    renewSeconds: seconds,
  });
  if (!result.ok) return refused(fromReasoned(result.refusal));
  return applied(result.value.taskId, null, {
    leaseId: result.value.leaseId,
    fence: result.value.fence,
    expiresAt: result.value.expiresAt.toISOString(),
  });
}

/**
 * The person renews the lease their own pickup took, under their current
 * rights. A person has no delegation to present, so the runtime checks the
 * lease carries none and re-reads the person's grants.
 */
export async function heartbeatOwnLease(
  tx: TenantQuery,
  context: CommandContext,
  fields: RenewalFields,
): Promise<HandlerOutcome> {
  const person = personClaimant(context);
  return await renewLease(
    fields,
    async (lease) =>
      await heartbeat(tx, {
        claimant: 'person',
        ...lease,
        holderActorId: person.actorId,
        subjects: person.subjects,
        collection: person.collection,
      }),
  );
}

// A malformed lease id is answered in the bytes the runtime gives a well-formed
// one that names nothing (root ruling 2), before it reaches a uuid parameter:
// `core-runtime/src/handback.ts:145-150` and `core-runtime/src/heartbeat.ts:82-87`.
export const NO_SUCH_LEASE: readonly string[] = [
  'no such lease in this business',
  'Hand back the lease this claim was issued.',
];
const NOT_THIS_CALLERS_LEASE: readonly string[] = [
  "the named lease is not this caller's at the presented fence",
  'Renew the lease this pickup issued, at the fence it handed back.',
];

/** The agent renews its own lease, under the delegation its credential resolved to. */
export async function heartbeatLease(
  tx: TenantQuery,
  fields: RenewalFields,
  agent: AgentClaimant,
  delegationId: string,
): Promise<HandlerOutcome> {
  return await renewLease(
    fields,
    async (lease) => await heartbeat(tx, { ...lease, holderActorId: agent.actorId, delegationId }),
  );
}
