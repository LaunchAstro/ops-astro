// SPDX-License-Identifier: AGPL-3.0-only
//
// The launched agent takes its launch (`task.take_launch`): the run a person
// opened by clicking Launch (`launches.ts`) moves from `waiting` to `started`,
// taken to answer, and the agent is handed the credential the launch's
// delegation was minted under, derived from the key as a pickup's is.
//
// Locks, in the order every writer of these rows meets them: the task row
// `for share` (a client link, a trash and a Launch take it `for update`), the
// launch `for update`, its delegation `for share` (a revocation updates it),
// the agent's actor `for share` (a deactivation updates it). One judgement
// follows, at `clock_timestamp()` after the last of them, so a revocation or
// an expiry that lands while the take waits is the one it reads.
//
// A started launch taken again by its own agent hands back the same
// credential: that is how a worker that restarted resumes. One that can no
// longer run is ended here, its delegation settled unless it was revoked, and
// the cause kept; an ended launch answers that receipt and no credential.

import {
  checkDelegatedAuthority,
  digestOf,
  resolveLiveById,
  settleDelegation,
} from './delegations.ts';
import { configuredCredentialKeys, DERIVED_SCHEME } from './credential-keys.ts';
import type { TenantQuery } from '../tenancy/database.ts';

/** The one kind of run a take starts. */
export const TAKEN_FOR = 'answer';

/** Why a launch could not run when it was taken. */
export type LaunchEndCause =
  'client' | 'trashed' | 'revoked' | 'settled' | 'lapsed' | 'agent_off' | 'narrowed';

export type TakeResult =
  /** The caller has no open launch, when it named none. */
  | { readonly kind: 'none' }
  /** No launch of the caller's own by that id: the same answer whether it exists or not. */
  | { readonly kind: 'not-yours' }
  /** The key this delegation was minted under is not held, or derives another credential. */
  | { readonly kind: 'no-key'; readonly why: string }
  | {
      readonly kind: 'started';
      readonly launchId: string;
      readonly taskId: string;
      readonly credential: string;
      /** Whether this take moved it from `waiting`; false when it resumed one already started. */
      readonly moved: boolean;
    }
  | {
      readonly kind: 'ended';
      readonly launchId: string;
      readonly taskId: string;
      readonly cause: LaunchEndCause | null;
    };

interface Judged {
  readonly state: 'waiting' | 'started' | 'ended';
  readonly ended_cause: LaunchEndCause | null;
  readonly delegation_id: string;
  readonly client: boolean;
  readonly trashed: boolean;
  readonly revoked: boolean;
  readonly settled: boolean;
  readonly lapsed: boolean;
  readonly active: boolean;
  readonly credential_scheme: string;
  readonly credential_key_id: string | null;
  readonly credential_hash: string;
}

/** The caller's own open launch: a started one first, so a restarted worker resumes before it takes more. */
async function ownOpenLaunch(tx: TenantQuery, agentActorId: string): Promise<string | undefined> {
  const rows = await tx.query<{ readonly id: string }>(
    `select id from public.task_launches
      where business_id = $1 and agent_actor_id = $2 and state <> 'ended'
      order by state = 'started' desc, launched_at, id
      limit 1`,
    [tx.businessId, agentActorId],
  );
  return rows[0]?.id;
}

/** Every lock, in order, then the one judgement after them. Undefined: not this agent's launch. */
async function lockAndJudge(
  tx: TenantQuery,
  agentActorId: string,
  launchId: string,
): Promise<{ readonly taskId: string; readonly judged: Judged } | undefined> {
  const named = await tx.query<{ readonly task_id: string }>(
    `select task_id from public.task_launches
      where business_id = $1 and id = $2 and agent_actor_id = $3`,
    [tx.businessId, launchId, agentActorId],
  );
  const taskId = named[0]?.task_id;
  if (taskId === undefined) return undefined;
  await tx.query('select 1 from public.records where business_id = $1 and id = $2 for share', [
    tx.businessId,
    taskId,
  ]);
  await tx.query(
    'select 1 from public.task_launches where business_id = $1 and id = $2 for update',
    [tx.businessId, launchId],
  );
  await tx.query(
    `select 1 from public.delegations d
       join public.task_launches l on l.business_id = d.business_id and l.delegation_id = d.id
      where l.business_id = $1 and l.id = $2
      for share of d`,
    [tx.businessId, launchId],
  );
  await tx.query('select 1 from public.actors where business_id = $1 and id = $2 for share', [
    tx.businessId,
    agentActorId,
  ]);
  const rows = await tx.query<Judged>(
    `select l.state, l.ended_cause, l.delegation_id,
            r.uuid_7 is not null as client, r.deleted_at is not null as trashed,
            d.revoked_at is not null as revoked, d.settled_at is not null as settled,
            d.expires_at <= clock_timestamp() as lapsed, a.active,
            d.credential_scheme, d.credential_key_id, d.credential_hash
       from public.task_launches l
       join public.records r on r.business_id = l.business_id and r.id = l.task_id
       join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
       join public.actors a on a.business_id = l.business_id and a.id = l.agent_actor_id
      where l.business_id = $1 and l.id = $2`,
    [tx.businessId, launchId],
  );
  const judged = rows[0];
  if (judged === undefined) throw new Error('launch-take: the launch locked is no longer readable');
  return { taskId, judged };
}

/** Why the launch cannot run now, in the order a person would look; undefined when it can. */
async function causeOf(
  tx: TenantQuery,
  agentActorId: string,
  taskId: string,
  judged: Judged,
): Promise<LaunchEndCause | undefined> {
  if (judged.client) return 'client';
  if (judged.trashed) return 'trashed';
  if (judged.revoked) return 'revoked';
  if (judged.settled) return 'settled';
  if (judged.lapsed) return 'lapsed';
  if (!judged.active) return 'agent_off';
  const delegation = await resolveLiveById(tx, agentActorId, judged.delegation_id);
  if (delegation === undefined) return 'lapsed';
  const reach = await checkDelegatedAuthority(tx, delegation, {
    collection: 'task',
    action: 'read',
    scope: { kind: 'record', id: taskId },
  });
  return reach.ok ? undefined : 'narrowed';
}

/** The credential the delegation was minted under, derived again and checked against its digest. */
function derivedCredential(
  businessId: string,
  agentActorId: string,
  judged: Judged,
): string | { readonly why: string } {
  const keys = configuredCredentialKeys();
  const keyId = judged.credential_key_id;
  if (!keys.ok || judged.credential_scheme !== DERIVED_SCHEME || keyId === null) {
    return { why: `delegation credential key ${keyId ?? 'unrecorded'}` };
  }
  const credential = keys.keys.derive(keyId, {
    businessId,
    agentActorId,
    delegationId: judged.delegation_id,
  });
  return credential ?? { why: `delegation credential key ${keyId}` };
}

export async function takeLaunch(
  tx: TenantQuery,
  agentActorId: string,
  named: string | undefined,
): Promise<TakeResult> {
  const launchId = named ?? (await ownOpenLaunch(tx, agentActorId));
  if (launchId === undefined) return { kind: 'none' };
  const locked = await lockAndJudge(tx, agentActorId, launchId);
  if (locked === undefined) return { kind: 'not-yours' };
  const { taskId, judged } = locked;
  if (judged.state === 'ended') {
    return { kind: 'ended', launchId, taskId, cause: judged.ended_cause };
  }
  const cause = await causeOf(tx, agentActorId, taskId, judged);
  if (cause !== undefined) {
    await tx.query(
      `update public.task_launches
          set state = 'ended', ended_at = clock_timestamp(), ended_cause = $3
        where business_id = $1 and id = $2`,
      [tx.businessId, launchId, cause],
    );
    if (!judged.revoked) await settleDelegation(tx, judged.delegation_id);
    return { kind: 'ended', launchId, taskId, cause };
  }
  const credential = derivedCredential(tx.businessId, agentActorId, judged);
  if (typeof credential !== 'string') return { kind: 'no-key', why: credential.why };
  if (digestOf(credential) !== judged.credential_hash) {
    return { kind: 'no-key', why: 'delegation credential integrity' };
  }
  const moved = judged.state === 'waiting';
  if (moved) {
    await tx.query(
      `update public.task_launches
          set state = 'started', taken_at = clock_timestamp(), taken_for = $3
        where business_id = $1 and id = $2`,
      [tx.businessId, launchId, TAKEN_FOR],
    );
  }
  return { kind: 'started', launchId, taskId, credential, moved };
}

/**
 * The commands a run taken to answer may send under its credential: it reads
 * its task, and the run's own command writes what lands. Nothing else, so the
 * actions the delegation was minted with (read, comment, write) are never
 * spent by the run directly.
 */
export const ANSWER_RUN_COMMANDS: ReadonlySet<string> = new Set(['task.read']);

/**
 * Whether a call under this delegation is outside what a launch taken to
 * answer may send. A launch leaves `waiting` only by a take, which records it
 * taken to answer, or by being ended once its delegation no longer stands, so
 * any launch past `waiting` holds its delegation to the run's commands.
 */
export async function excludedFromTakenLaunch(
  tx: TenantQuery,
  delegationId: string,
  command: string,
): Promise<boolean> {
  if (ANSWER_RUN_COMMANDS.has(command)) return false;
  const launches = await tx.query<{ readonly task_id: string }>(
    `select task_id from public.task_launches where business_id = $1 and delegation_id = $2`,
    [tx.businessId, delegationId],
  );
  if (launches.length === 0) return false;
  // The global lock order (`core-runtime/src/locks.ts`): the business's caps,
  // then the launch's task, as a take takes it, then the launch read afresh.
  // The caps come first because the write this call admits may go on to take
  // one (a proposal does) while a holder of that cap waits on the task. A take
  // that started the launch while this call waited for the task is seen once
  // it has committed, so a write parked behind it is refused.
  await tx.query(`select 1 from public.budget_caps where business_id = $1 order by id for update`, [
    tx.businessId,
  ]);
  await tx.query(
    `select 1 from public.records where business_id = $1 and id = any($2::uuid[]) for no key update`,
    [tx.businessId, launches.map((launch) => launch.task_id)],
  );
  const rows = await tx.query(
    `select 1 from public.task_launches
      where business_id = $1 and delegation_id = $2 and state <> 'waiting'`,
    [tx.businessId, delegationId],
  );
  return rows.length > 0;
}
