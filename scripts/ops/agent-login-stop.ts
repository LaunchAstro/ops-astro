// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent's stop (agent-login.ts). One acting transaction switches the agent
// off: its live delegations revoked (read again once the agent is locked, so a
// pickup that committed during the wait is revoked too), the agent and its
// login mapping deactivated, never deleted, every session of its sign-in ended
// in every business, and a receipt written that carries the stopped subject
// and owes the provider's ban. Then the ban, one transaction per attempt,
// under the subject's lock, read from the receipt and never from the current
// mappings. A subject live in another business is ended nowhere and banned
// nowhere: the receipt records it shared. A ban the provider did not make
// stays owed, and a rerun of stop finishes it.

import { createGoTrueLogins } from '../../apps/api/auth/logins.ts';
import {
  advisoryLock,
  factorDigest,
  factorLoginLiveElsewhere,
  revokeDelegation,
} from '../../packages/core-records/src/index.ts';
import { subjectKey } from '../../packages/core-records/src/identity/ending-keys.ts';
import { acting, type Act, type Execute, type Run } from './agent-login-acting.ts';
import { Refusal } from './staging-reset.ts';

interface Mapping {
  readonly login_id: string;
  readonly subject: string;
  readonly active: boolean;
}

const MAPPINGS = `select m.login_id, l.subject, m.active from public.actor_logins m
    join public.logins l on l.business_id = m.business_id and l.id = m.login_id
   where m.business_id = $1 and m.actor_id = $2 order by m.id`;
const LIVE_DELEGATIONS = `select id from public.delegations
   where business_id = $1 and agent_actor_id = $2 and revoked_at is null and settled_at is null
   order by id for update`;

const closing = async (execute: Execute, id: string, set: string): Promise<Act> => {
  const [row] = await execute<Act>(
    `update ops.agent_login_acts set ${set}, closed_at = clock_timestamp(),
       updated_at = clock_timestamp() where id = $1 returning *`,
    [id],
  );
  if (row === undefined) throw new Error('agent-login: the receipt is gone');
  return row;
};

/** The ban the receipt owes, under the receipt's subject lock, held through the provider's answer. */
async function ban(run: Run, receipt: Act): Promise<Act> {
  return await acting(run, receipt.provider_subject, async (execute) => {
    const [row] = await execute<Act>(
      'select * from ops.agent_login_acts where id = $1 for update',
      [receipt.id],
    );
    if (row?.ban !== 'owed' || row.provider_subject === null || row.login_id === null)
      return row ?? receipt;
    const tx = { businessId: run.businessId, query: execute };
    if (await factorLoginLiveElsewhere(tx, row.login_id))
      return await closing(execute, row.id, "ban = 'shared'");
    const provider = createGoTrueLogins({
      baseUrl: run.env['GOTRUE_URL'] ?? '',
      adminKey: async () => await Promise.resolve(run.env['SUPABASE_SERVICE_KEY'] ?? ''),
    });
    const banned = await provider.deactivate(row.provider_subject);
    if (!banned.ok)
      throw new Refusal(
        `the agent is stopped, and the ban of its old provider user is owed (${banned.fault}): run stop again`,
      );
    return await closing(execute, row.id, "ban = 'done', ban_done_at = clock_timestamp()");
  });
}

/** Every open act closed, and the stop's receipt, owing the ban when the subject was ended. */
async function receiptOf(
  execute: Execute,
  run: Run,
  stopped: {
    agent: { active: boolean; deactivated_at: Date | null };
    at: Date | undefined;
    mapping: Mapping | undefined;
    shared: boolean;
    ended: boolean;
  },
): Promise<Act | null> {
  const key = [run.businessId, run.make.agentId];
  const { agent, at, mapping, shared, ended } = stopped;
  await execute(
    `update ops.agent_login_acts set closed_at = clock_timestamp(), updated_at = clock_timestamp()
      where business_id = $1 and agent_actor_id = $2 and closed_at is null`,
    key,
  );
  const owed = mapping === undefined ? null : shared ? 'shared' : 'owed';
  const [receipt] = await execute<Act>(
    `insert into ops.agent_login_acts (business_id, agent_actor_id, act, provider_subject, login_id,
       phase, actor_was_active, actor_deactivated_at, stopped_at, sessions_ended, ban, closed_at,
       operator_person_id)
     values ($1, $2, 'stop', $3, $4, 'stopped', $5, $6, clock_timestamp(), $7, $8,
       case when $8 = 'owed' then null else clock_timestamp() end, $9) returning *`,
    [
      ...key,
      mapping?.subject ?? null,
      mapping?.login_id ?? null,
      agent.active,
      at ?? agent.deactivated_at,
      ended,
      owed,
      run.gate.operator.personId,
    ],
  );
  return receipt ?? null;
}

/** The database stop, in one transaction; nothing when the agent is already stopped. */
async function switchOff(execute: Execute, run: Run, subject: string | null): Promise<Act | null> {
  const tx = { businessId: run.businessId, query: execute };
  const key = [run.businessId, run.make.agentId];
  await execute(LIVE_DELEGATIONS, key);
  const [agent] = await execute<{ kind: string; active: boolean; deactivated_at: Date | null }>(
    'select kind, active, deactivated_at from public.actors where business_id = $1 and id = $2 for no key update',
    key,
  );
  if (agent?.kind !== 'agent')
    throw new Refusal(`--agent is not an agent of ${run.gate.operator.business}`);
  const delegations = await execute<{ id: string }>(LIVE_DELEGATIONS, key);
  const mapping = (await execute<Mapping>(`${MAPPINGS} for update of m`, key)).find(
    (m) => m.active,
  );
  if ((mapping?.subject ?? null) !== subject)
    throw new Refusal("the agent's login changed while the stop waited: run stop again");
  if (mapping === undefined && !agent.active && delegations.length === 0) return null;
  const shared = mapping !== undefined && (await factorLoginLiveElsewhere(tx, mapping.login_id));
  for (const delegation of delegations)
    // oxlint-disable-next-line no-await-in-loop -- one at a time, in id order
    await revokeDelegation(tx, delegation.id, 'delegation_revoked');
  const [off] = await execute<{ at: Date }>(
    `update public.actors set active = false, deactivated_at = clock_timestamp()
      where business_id = $1 and id = $2 and active returning deactivated_at as at`,
    key,
  );
  await execute(
    `update public.actor_logins set active = false, deactivated_at = clock_timestamp()
      where business_id = $1 and actor_id = $2 and active`,
    key,
  );
  if (mapping !== undefined && !shared) {
    await advisoryLock(tx, subjectKey(mapping.subject));
    await execute('insert into ops.ended_subject_sessions (subject_digest) values ($1)', [
      factorDigest(mapping.subject),
    ]);
  }
  const ended = mapping !== undefined && !shared;
  return await receiptOf(execute, run, { agent, at: off?.at, mapping, shared, ended });
}

/** The stop: owed bans finished first, then the agent switched off and its ban made. */
export async function stopAct(run: Run): Promise<readonly Act[]> {
  const owed = await run.admin.execute<Act>(
    `select * from ops.agent_login_acts where business_id = $1 and agent_actor_id = $2
        and act = 'stop' and ban = 'owed' order by created_at`,
    [run.businessId, run.make.agentId],
  );
  const touched: Act[] = [];
  for (const receipt of owed)
    // oxlint-disable-next-line no-await-in-loop -- each owed ban in the order it was owed
    touched.push(await ban(run, receipt));
  const read = await run.admin.execute<Mapping>(MAPPINGS, [run.businessId, run.make.agentId]);
  const subject = read.find((m) => m.active)?.subject ?? null;
  const receipt = await acting(
    run,
    subject,
    async (execute) => await switchOff(execute, run, subject),
  );
  if (receipt !== null) touched.push(receipt.ban === 'owed' ? await ban(run, receipt) : receipt);
  return touched;
}
