// SPDX-License-Identifier: AGPL-3.0-only
//
// A stored success released on replay, by the operation's `replay` row
// (`agent-operations.ts`). A stored refusal carries nothing protected and is
// never passed here. Nothing here repeats anything: the refusal comes back,
// not the stored detail, when the rights are gone.

import type { TenantQuery } from '../tenancy/database.ts';
import type { AgentSession } from '../identity/agent-login.ts';
import {
  checkDelegatedAuthority,
  digestOf,
  resolveLiveById,
  resolveSettledByLease,
} from '../authority/delegations.ts';
import { DERIVED_SCHEME, LEGACY_SCHEME } from '../authority/credential-keys.ts';
import { delegationCredentialKeys } from './runtime-config.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import { declarationOf } from './surface.ts';
import type { CommandHandle, CommandResult } from './register-store.ts';
import { fromRuntime } from './tasks-runtime.ts';
import { authorise, NO_DELEGATION_FIXES } from './agent-authority.ts';
import { capabilitiesOf, UUID, type AgentCall, type AgentOperation } from './agent-operations.ts';

/**
 * The stored success as the rights held now release it: the answer to hand
 * back in its place, a refusal, or nothing when the receipt goes out as stored.
 */
export async function releaseReplay(
  tx: TenantQuery,
  call: AgentCall,
  operation: AgentOperation,
  stored: CommandHandle,
): Promise<CommandResult | undefined> {
  switch (operation.replay) {
    case 'pickup':
      return await replayPickup(tx, call.session, stored);
    case 'capabilities':
      return await replayCapabilities(tx, call, operation);
    case 'settledHandback':
      return await replaySettledHandback(tx, call, stored);
    case 'reauthorise': {
      const authorised = await authorise(tx, call, operation);
      return 'refusal' in authorised ? authorised.refusal : undefined;
    }
  }
}

/**
 * A capabilities replay: the current rights checked the way a fresh call is,
 * then the answer projected for them. The stored answer is never released.
 */
async function replayCapabilities(
  tx: TenantQuery,
  call: AgentCall,
  operation: AgentOperation,
): Promise<CommandResult> {
  const authorised = await authorise(tx, call, operation);
  if ('refusal' in authorised) return authorised.refusal;
  return {
    command: call.request.command,
    recordId: null,
    revision: null,
    detail: { ...(await capabilitiesOf(tx, call.session, authorised.delegation)) },
  };
}

/**
 * The note a replayed pickup carries in place of its credential, when its
 * delegation predates derivation (`legacy-random`) and nothing can give the
 * credential back.
 */
export const CREDENTIAL_NOT_REPLAYED = 'CREDENTIAL_NOT_REPLAYED';

const PICKUP_REPLAY_FIXES: readonly string[] = [
  'The work this pickup claimed is no longer yours to resume.',
  'Re-read the queue.',
];

interface PickupBindingRow {
  readonly credential_scheme: string;
  readonly credential_key_id: string | null;
  readonly credential_hash: string;
  readonly lease_live: boolean;
  readonly approval_current: boolean;
}

/**
 * A pickup's replay, which is the case where the agent lost the answer that
 * carried its credential and so has none to present (root ruling 6: the
 * deliberate exception to "no credential, no call").
 *
 * In order, and every step reads the rows as they are now:
 *
 * 1. The delegation the receipt names is still live and still this agent's.
 * 2. The delegating person's current grants still cover the pickup's purpose.
 * 3. The receipt's lease, reservation, attempt and delegation are still bound
 *    to one another, to this agent, and to the receipt's task and version. The
 *    lease is live and unexpired, the hold is held, and the approval behind it
 *    is still current.
 * 4. Only then is the credential derived under the delegation's pinned scheme
 *    and key id, and its digest compared with the one stored at mint.
 *
 * A missing key or a digest that does not match is a closed failure. The
 * receipt is not rewritten, nothing is minted in its place, and no lease,
 * hold, expiry or delegation is touched. A `legacy-random` delegation answers
 * its receipt with no credential and says why, because a digest cannot give
 * random bytes back.
 */
async function replayPickup(
  tx: TenantQuery,
  session: AgentSession,
  stored: CommandHandle,
): Promise<CommandResult> {
  const detail = stored.detail;
  const named = (key: string): string => {
    const value = detail[key];
    return typeof value === 'string' && UUID.test(value) ? value : '';
  };
  const delegationId = named('delegationId');
  const held =
    delegationId === '' ? undefined : await resolveLiveById(tx, session.actorId, delegationId);
  if (held === undefined) return refuseCommand('DELEGATION_NOT_LIVE', [], PICKUP_REPLAY_FIXES);

  const declaration = declarationOf('task.pickup');
  const decision = await checkDelegatedAuthority(tx, held, {
    collection: declaration?.collection ?? 'task',
    action: declaration?.action ?? 'write',
    scope: held.purposeScope,
  });
  if (!decision.ok) return fromRuntime(decision.refusal);

  const rows = await tx.query<PickupBindingRow>(
    `select d.credential_scheme, d.credential_key_id, d.credential_hash,
            (l.state = 'live' and l.expires_at > now() and res.state = 'held') as lease_live,
            (g.state = 'approved' and lin.state = 'live' and ver.superseded_at is null)
              as approval_current
       from public.leases l
       join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
       join public.reservations res on res.business_id = l.business_id and res.lease_id = l.id
       join public.attempts att
         on att.business_id = l.business_id and att.reservation_id = res.id and att.lease_id = l.id
       join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
       join public.proposal_versions ver
         on ver.business_id = res.business_id and ver.id = res.version_id
       join public.proposal_lineages lin
         on lin.business_id = res.business_id and lin.id = run.lineage_id
       join public.gates g on g.business_id = res.business_id and g.version_id = res.version_id
      where l.business_id = $1 and l.id = $2 and d.id = $3 and res.id = $4 and att.id = $5
        and l.holder_actor_id = $6 and d.agent_actor_id = $6
        and l.task_id = $7 and res.version_id = $8`,
    [
      tx.businessId,
      named('leaseId'),
      delegationId,
      named('reservationId'),
      named('attemptId'),
      session.actorId,
      named('taskId'),
      named('versionId'),
    ],
  );
  const bound = rows[0];
  if (bound === undefined) return refuseCommand('LEASE_NOT_OWNED', [], PICKUP_REPLAY_FIXES);
  if (!bound.lease_live) return refuseCommand('LEASE_EXPIRED', [], PICKUP_REPLAY_FIXES);
  if (!bound.approval_current) {
    return refuseCommand('RESERVATION_NOT_CLAIMABLE', [], PICKUP_REPLAY_FIXES);
  }

  // `credential` is read by the spread below and then replaced; the note, if
  // an older row carries one, does not survive into a derived answer.
  const { credentialNote: _note, ...handles } = detail;
  if (bound.credential_scheme === LEGACY_SCHEME) {
    return {
      ...stored,
      detail: { ...handles, credential: null, credentialNote: CREDENTIAL_NOT_REPLAYED },
    };
  }
  const keyId = bound.credential_key_id;
  const keys = delegationCredentialKeys();
  const credential =
    bound.credential_scheme !== DERIVED_SCHEME || keyId === null || !keys.ok
      ? undefined
      : keys.keys.derive(keyId, {
          businessId: tx.businessId,
          agentActorId: session.actorId,
          delegationId,
        });
  if (credential === undefined) {
    return refuseCommand(
      'DEPENDENCY_NOT_LANDED',
      ['task.pickup', `delegation credential key ${keyId ?? 'unrecorded'}`],
      [
        'This deployment does not hold the key this delegation was minted under.',
        'Restore that key; the pickup is unchanged and replays once it is back.',
      ],
    );
  }
  if (digestOf(credential) !== bound.credential_hash) {
    return refuseCommand(
      'DEPENDENCY_NOT_LANDED',
      ['task.pickup', 'delegation credential integrity'],
      [
        'The credential derived for this pickup does not match the one it was issued.',
        'Nothing was reissued. Restore the key this delegation was minted under.',
      ],
    );
  }
  return { ...stored, detail: { ...handles, credential } };
}

/**
 * Whether a stored handback may be released to the rights held now.
 *
 * Most operations answer to the same check a fresh call does. A pickup has its
 * own path (`replayPickup`). A handback cannot answer to the fresh check
 * either: it settles its own delegation, so the credential that made it no
 * longer resolves as live. Its receipt is released to that same credential,
 * for that delegation's own lease, while the delegation was settled rather
 * than revoked and has not expired, and the person's grants still cover it.
 * With no credential at all, a handback replay is what any bare agent call
 * outside the queue and pickup is (root ruling 6): an exclusion, with nothing
 * of the receipt in it.
 */
async function replaySettledHandback(
  tx: TenantQuery,
  { session, credential, request }: AgentCall,
  stored: CommandHandle,
): Promise<CommandRefusal | undefined> {
  if (credential === undefined || credential === '') {
    return refuseCommand('DELEGATION_EXCLUDES_OPERATION', [request.command], NO_DELEGATION_FIXES);
  }
  const leaseId = String(stored.detail['leaseId'] ?? '');
  const held = UUID.test(leaseId)
    ? await resolveSettledByLease(tx, session.actorId, leaseId, credential)
    : undefined;
  if (held === undefined) return refuseCommand('DELEGATION_NOT_LIVE', [], NO_DELEGATION_FIXES);
  const declaration = declarationOf(request.command);
  const decision = await checkDelegatedAuthority(tx, held, {
    collection: declaration?.collection ?? 'task',
    action: declaration?.action ?? 'write',
    scope: held.purposeScope,
  });
  return decision.ok ? undefined : fromRuntime(decision.refusal);
}
