// SPDX-License-Identifier: AGPL-3.0-only
//
// Every agent write is judged again after its last wait, with the locks held.
//
// The door reads the agent's login mapping and its session, and `authorise`
// its delegation, without a lock, and the handler can wait on rows after
// both. A stop of the login, a revoked delegation or an ended session that
// commits during that wait must still refuse the write, and one that comes
// later must wait for it. So once the handler has applied, and before its
// register row and audit event (`agent-envelope.ts`), this takes in order: the
// presented delegation, the agent actor and the session's login mapping, each
// `for share`; the business's audit chain; then the subject's and the
// session's ending keys, shared (`sessionEndedHeld`). Then it reads each again,
// the delegation a take hands over (`handsOver`), which the take already
// holds `for share` from its own judgement (`launch-take.ts`), and the
// delegating person's grants, asked again as `authorise` asked them, except
// for a retained stop.
//
// The grants are read, not held: `grant.revoke` takes its grant before the
// task (`LOCK_ORDER`), and this runs after the handler's task lock. Its audit
// event takes the same chain lock, so a revocation either committed before
// this read, which then refuses, or commits after this write.
//
// That order cannot deadlock with a stop of the login, which takes the same
// rows in the same order and no audit lock, nor with a launched run's
// judgement, which takes the session keys shared before the chain, as shared
// keys never wait on each other. The stop takes the actor `for no key update`:
// the door's attempt row holds it `for key share`, which `for update` waits on.

import {
  advisoryLock,
  checkDelegatedAuthority,
  digestOf,
  EXPIRED_FIXES,
  NO_AGENT_FIXES,
  resolveLiveById,
  sessionEndedHeld,
  type TenantQuery,
  type VerifiedSubject,
} from '../../../core-records/src/index.ts';
import { inSavepoint } from './agent-applied.ts';
import type { AgentCall } from './agent-call.ts';
import type { Asked } from './agent-authority.ts';
import { isRefused, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';

const NOT_LIVE_FIXES: readonly string[] = ['ask the authorising person for a current delegation'];

/** What an agent call is judged on: the call, the bearer it presented, what `authorise` asked. */
export interface Judged {
  readonly call: Pick<AgentCall, 'session' | 'credential' | 'declaration'>;
  readonly presented: VerifiedSubject;
  readonly asked: Asked | undefined;
}

const STOPS: ReadonlySet<string> = new Set(['model.call', 'run.end']);

/**
 * The handler's work in its savepoint, judged again once it has applied. A
 * refusal here rolls the work back and is answered under no operation id, as
 * the person path's refusal at commit is, so the agent can send the same
 * operation again once it is let back in.
 */
export async function workJudged(
  tx: TenantQuery,
  judged: Judged,
  work: () => Promise<HandlerOutcome>,
): Promise<HandlerOutcome | { readonly ended: CommandRefusal }> {
  const standing: { ended: CommandRefusal | undefined } = { ended: undefined };
  const outcome = await inSavepoint(tx, async () => {
    const ran = await work();
    // Only a stop that retired its own work (#1623 R1) keeps rows that are judged.
    const retained = isRefused(ran);
    if (retained && (ran.retains !== true || !STOPS.has(judged.call.declaration.name))) return ran;
    const handsOver = retained ? undefined : ran.handsOver;
    standing.ended = await agentStanding(tx, judged, retained, handsOver);
    if (standing.ended !== undefined) return refused(standing.ended);
    if (retained) return ran;
    const last = await ran.lastCheck?.();
    return last === undefined ? ran : refused(last);
  });
  return standing.ended === undefined ? outcome : { ended: standing.ended };
}

/**
 * The refusal the door would give this agent call now, or nothing. A retained
 * stop's own retirement of its delegation is the write, not a lapse.
 */
async function agentStanding(
  tx: TenantQuery,
  { call: { session, credential }, presented, asked }: Judged,
  retained: boolean,
  handsOver: string | undefined,
): Promise<CommandRefusal | undefined> {
  const delegationId =
    credential === undefined || credential === ''
      ? undefined
      : await holdDelegation(tx, session.actorId, credential);
  await tx.query('select 1 from public.actors where business_id = $1 and id = $2 for share', [
    tx.businessId,
    session.actorId,
  ]);
  await tx.query(
    `select 1 from public.actor_logins
      where business_id = $1 and login_id = $2 and actor_id = $3 for share`,
    [tx.businessId, session.loginId, session.actorId],
  );
  await advisoryLock(tx, tx.businessId.toLowerCase());

  if (!(await stillTheAgent(tx, session))) {
    return refuseCommand('AUTH_NO_AGENT_IDENTITY', [], NO_AGENT_FIXES);
  }
  if (await sessionEndedHeld(tx, presented)) {
    return refuseCommand('AUTH_SESSION_EXPIRED', [], EXPIRED_FIXES);
  }
  if (
    handsOver !== undefined &&
    (await resolveLiveById(tx, session.actorId, handsOver)) === undefined
  ) {
    return refuseCommand('DELEGATION_NOT_LIVE', [], NOT_LIVE_FIXES);
  }
  // Only the rows that served under a delegation answer to it. A helper's
  // handback answers to its credential, live or not (`agent-authority.ts`).
  if (asked === undefined) return undefined;
  if (
    delegationId === undefined ||
    !(await delegationStands(tx, session.actorId, delegationId, retained))
  ) {
    return refuseCommand('DELEGATION_NOT_LIVE', [], NOT_LIVE_FIXES);
  }
  // A retained stop answers to its delegation alone: it retires its own work.
  if (retained) return undefined;
  const reach = await checkDelegatedAuthority(tx, asked.delegation, asked.request);
  return reach.ok ? undefined : reach.refusal;
}

/** The presented delegation's row, `for share`, by the binding `resolveDelegation` uses. */
async function holdDelegation(
  tx: TenantQuery,
  agentActorId: string,
  credential: string,
): Promise<string | undefined> {
  const rows = await tx.query<{ readonly id: string }>(
    `select id from public.delegations
      where business_id = $1 and agent_actor_id = $2 and credential_hash = $3 for share`,
    [tx.businessId, agentActorId, digestOf(credential)],
  );
  return rows[0]?.id;
}

/** The login still maps to this actor, and the actor is still an active agent. */
async function stillTheAgent(tx: TenantQuery, session: AgentCall['session']): Promise<boolean> {
  const rows = await tx.query(
    `select 1 from public.actor_logins al
       join public.actors a on a.business_id = al.business_id and a.id = al.actor_id
      where al.business_id = $1 and al.login_id = $2 and al.actor_id = $3
        and al.active and a.active and a.kind = 'agent'`,
    [tx.businessId, session.loginId, session.actorId],
  );
  return rows.length > 0;
}

/**
 * Live now, or handed back by this very call: a handback settles its own
 * delegation (`settleDelegation` stamps the transaction's `now()`), and that
 * is the write, not a lapse. So is a retained stop's retirement of its own work (`revokeDelegation`
 * stamps `now()` too, cause `work_retired`). Another revocation or an expiry still refuses it.
 */
async function delegationStands(
  tx: TenantQuery,
  agentActorId: string,
  delegationId: string,
  retained: boolean,
): Promise<boolean> {
  if ((await resolveLiveById(tx, agentActorId, delegationId)) !== undefined) return true;
  const rows = await tx.query(
    `select 1 from public.delegations
      where business_id = $1 and id = $2 and expires_at > clock_timestamp()
        and ((revoked_at is null and settled_at = now())
          or ($3 and revocation_cause = 'work_retired'
              and revoked_at = greatest(now(), granted_at)))`,
    [tx.businessId, delegationId, retained],
  );
  return rows.length > 0;
}
