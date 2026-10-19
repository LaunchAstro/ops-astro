// SPDX-License-Identifier: AGPL-3.0-only
//
// A task's call carried to the model agent on the owner's machine (#1703,
// #1620 P5): its handoff to the carried custody, the hosted side's half.
//
// The bearer is the calling agent's own token, the one it presented at
// the door: the carried custody joins the call's line with it, and the join
// policy admits the agent holding the call's live lease. The hosted side
// never holds the owner's plan token; only the model agent's custody does,
// on the M5.
//
// Final authority: both judgements take every lock the call rests on
// (`lockCarriedTask`), then the task grants each delegation draws on, for
// share `nowait` (runtime rows are held, and `grant.revoke` takes grants
// first: contention refuses, nothing sent), then the calling agent's ending
// keys, shared, then read the instant and judge at it (`judgeCarriedTask`):
// the agent's login and session, its token's expiry, the lease, each
// delegation and the `task:write` it still carries on the lease's task. The send
// judgement comes after the agent's accept, so after its prepare and the
// refresh it may wait on: a client link, a delegation ending or a session
// ending committed during that wait is seen, and nothing is sent. Its
// transaction holds those locks through the socket write, or W after the
// accept was heard (`holdSend`).

import {
  judgeCarriedTask,
  lockCarriedTask,
  type CarriedTask,
  type Handoff,
  type Judged,
} from '../../../core-custody/src/index.ts';
import {
  checkDelegatedAuthority,
  delegatingSubjects,
  resolveLiveById,
  sessionEndedHeld,
  type BusinessId,
  type Database,
  type Delegation,
  type TenantQuery,
  type VerifiedSubject,
} from '../../../core-records/src/index.ts';
import { holdCoveringGrants, lockedInstant } from '../../../core-runtime/src/index.ts';
import { busy, holdSend, LOST } from './carriage-fence.ts';
import { expiresAt, recordSend } from './carriage-origin.ts';

interface Asked {
  readonly presented: VerifiedSubject;
  readonly accessToken: string;
  readonly task: CarriedTask;
}

/** The calling agent's login, still mapped to the caller and active, with no ending, held for share. */
async function agentStands(tx: TenantQuery, asked: Asked): Promise<boolean> {
  const rows = await tx.query(
    `select 1 from public.logins l
       join public.actor_logins al
         on al.business_id = l.business_id and al.login_id = l.id and al.active
       join public.actors a
         on a.business_id = al.business_id and a.id = al.actor_id and a.kind = 'agent' and a.active
      where l.business_id = $1 and l.provider = $2 and l.subject = $3 and a.id = $4
        and not exists (select 1 from public.access_endings e
                         where e.business_id = l.business_id and e.login_id = l.id)
      for share of al, a`,
    [tx.businessId, asked.presented.provider, asked.presented.subject, asked.task.caller.actorId],
  );
  return rows.length > 0;
}

interface Delegators {
  readonly task: string;
  readonly delegations: readonly Delegation[];
  readonly held: ReadonlySet<string>;
}

/** The lease's task, its live delegations and their subjects' task grants, held `nowait`; none, null. */
async function holdDelegators(
  tx: TenantQuery,
  asked: Asked,
  ids: readonly (string | null)[],
): Promise<Delegators | null> {
  const [lease] = await tx.query<{ readonly task: string }>(
    `select task_id::text as task from public.leases where business_id = $1 and id = $2`,
    [tx.businessId, asked.task.request.leaseId],
  );
  const delegations: Delegation[] = [];
  for (const id of new Set(ids)) {
    // oxlint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
    const live = id === null ? undefined : await resolveLiveById(tx, asked.task.caller.actorId, id);
    if (live !== undefined) delegations.push(live);
    else if (id !== null) return null;
  }
  if (lease === undefined || delegations.length === 0) return null;
  const subjects = [];
  for (const delegation of delegations) {
    // oxlint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
    subjects.push(...(await delegatingSubjects(tx, delegation)));
  }
  const held = await holdCoveringGrants(tx, subjects, 'task', 'nowait');
  return { task: lease.task, delegations, held: new Set(held) };
}

/** Whether each delegation still carries `task:write` on the lease's task at `at`, through a grant held. */
async function delegatorsStand(tx: TenantQuery, by: Delegators, at: string): Promise<boolean> {
  const scope = { kind: 'record', id: by.task } as const;
  for (const delegation of by.delegations) {
    // oxlint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
    const asked = await checkDelegatedAuthority(tx, delegation, {
      collection: 'task',
      action: 'write',
      scope,
    });
    if (!asked.ok) return false;
    // oxlint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
    const live = await tx.query(
      `select 1 from public.grants
        where business_id = $1 and id = any($2::uuid[])
          and (expires_at is null or expires_at > $3::timestamptz)`,
      [tx.businessId, asked.value.filter((id) => by.held.has(id)), at],
    );
    if (live.length === 0) return false;
  }
  return true;
}

/** Every lock in order, then the judgement at the instant read after them. */
async function judgeTask(
  tx: TenantQuery,
  asked: Asked,
  mode: 'offer' | { readonly runner: string },
): Promise<Judged> {
  const held = await lockCarriedTask(tx, asked.task, mode);
  if (!('facts' in held)) return held;
  const { delegationId, callerDelegationId } = held.facts;
  const delegators = await holdDelegators(tx, asked, [delegationId, callerDelegationId]);
  const ended = await sessionEndedHeld(tx, asked.presented);
  const stands = await agentStands(tx, asked);
  const at = await lockedInstant(tx);
  if (ended || !stands || expiresAt(asked.accessToken) <= Date.parse(at)) return LOST;
  if (delegators === null || !(await delegatorsStand(tx, delegators, at))) return LOST;
  return await judgeCarriedTask(tx, asked.task, held, at);
}

/** The offer judgement; passing, `offered_at` is set and its trigger rings the doorbell, ids only. */
async function offer(database: Database, businessId: BusinessId, asked: Asked): Promise<Judged> {
  return await database
    .withBusiness(businessId, async (tx) => {
      const passed = await judgeTask(tx, asked, 'offer');
      if (!passed.ok) return passed;
      await tx.query(
        `update public.model_call_carriers set offered_at = clock_timestamp()
          where business_id = $1 and call_id = $2 and offered_at is null`,
        [tx.businessId, asked.task.callId],
      );
      return passed;
    })
    .catch(busy);
}

/**
 * The handoff for one task call: its two judgements under the calling
 * agent's own token, with `timeoutMs` the operation's wait, which
 * `answer_by` allows for.
 */
export function taskHandoff(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  accessToken: string,
  carried: Omit<CarriedTask, 'callId'> & { readonly timeoutMs: number },
): (callId: string) => Handoff {
  const { timeoutMs, ...task } = carried;
  return (callId) => {
    const asked: Asked = { presented, accessToken, task: { ...task, callId } };
    return {
      businessId,
      callId,
      accessToken,
      offer: async () => await offer(database, businessId, asked),
      fence: async ({ runner, acceptedAt, heardAt }) => {
        const accept = { runner, acceptedAt, timeoutMs };
        if (!(await recordSend(database, businessId, callId, accept))) {
          return { ok: false, code: 'DECISION_STALE' };
        }
        return await holdSend<null>(
          async (work) =>
            await database.withBusiness(businessId, async (tx) => await work(tx, null)),
          async (tx) => await judgeTask(tx, asked, { runner }),
          heardAt,
        );
      },
    };
  };
}
