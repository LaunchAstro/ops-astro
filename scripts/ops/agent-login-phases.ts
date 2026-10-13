// SPDX-License-Identifier: AGPL-3.0-only
//
// A make's phases (agent-login.ts), each its own acting transaction
// (agent-login-acting.ts): reserve the act, make the provider user, bind the
// login, then probe it as the agent and close the act. A rerun resumes from
// the act's recorded phase, and each phase reads the phase again under the
// act row's lock, so two runs at once do each step once.

import { randomUUID } from 'node:crypto';
import { agentSignIn } from '../../apps/worker/sign-in.ts';
import { executeAgentCommand, isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import {
  acting,
  admitted,
  liveLogins,
  signedIn,
  NOT_OURS,
  subjectFree,
  type Act,
  type Execute,
  type Run,
} from './agent-login-acting.ts';
import { admission, type Admission } from './agent-login-admission.ts';
import { providerUser } from './agent-login-provider.ts';
import { Refusal } from './staging-reset.ts';

/** A named point of the act; a test's throw there is a crash at that point. */
export type At = (point: string) => Promise<void>;
/** An act's admission: make's, or restore's (agent-login-restore.ts). */
export type Admit = (execute: Execute, run: Run) => Promise<Admission>;

const PROBE_FAILED =
  'the probe did not answer as the agent: the login stays bound, and a rerun probes again';

const actRow = async (execute: Execute, id: string): Promise<Act> => {
  const [row] = await execute<Act>('select * from ops.agent_login_acts where id = $1 for update', [
    id,
  ]);
  if (row === undefined) throw new Error('agent-login: the act row is gone');
  return row;
};

const advance = async (
  execute: Execute,
  id: string,
  set: string,
  values: readonly unknown[],
): Promise<Act> => {
  const [row] = await execute<Act>(
    `update ops.agent_login_acts set ${set}, updated_at = clock_timestamp() where id = $1 returning *`,
    [id, ...values],
  );
  if (row === undefined) throw new Error('agent-login: the act row is gone');
  return row;
};

async function reserve(
  execute: Execute,
  run: Run,
  at: At,
  admit: Admit,
): Promise<Act | { already: Act }> {
  const decided = await admit(execute, run);
  await at('reserve');
  if (!('fresh' in decided)) return 'open' in decided ? decided.open : decided;
  const [act] = await execute<Act>(
    `insert into ops.agent_login_acts
       (business_id, agent_actor_id, act, generation, email, custody_item, phase, operator_person_id)
     values ($1, $2, $6, $7, $3, $4, 'reserved', $5) returning *`,
    [
      run.businessId,
      run.make.agentId,
      decided.fresh.email,
      decided.fresh.item,
      run.gate.operator.personId,
      run.make.act,
      decided.fresh.generation,
    ],
  );
  if (act === undefined) throw new Error('agent-login: the act was not reserved');
  return act;
}

/** The act row locked after the agent, its owner and its mappings; `live` the mappings' logins. */
async function locked(execute: Execute, run: Run, id: string, admit: Admit) {
  // The act's admission judged again first, under the same locks in the same order.
  await admit(execute, run);
  const { ownerActor } = await admitted(execute, run, run.make.act === 'make');
  const live = await liveLogins(execute, run);
  const act = await actRow(execute, id);
  if (act.closed_at !== null && act.phase !== 'probed')
    throw new Refusal('the act was closed by a stop');
  return { ownerActor, live, act };
}

/**
 * The provider phase judges the act's admission again under its own locks,
 * no live login on the agent but its act's included, and the operator's
 * bearer after the last of those waits, before it makes a provider user.
 */
async function provide(
  execute: Execute,
  run: Run,
  id: string,
  password: string,
  { at, admit }: { at: At; admit: Admit },
) {
  const decided = await admit(execute, run);
  const act = 'open' in decided ? decided.open : await actRow(execute, id);
  if (act.id !== id || act.phase !== 'reserved') return act;
  await signedIn(run);
  const subject = await providerUser(run, act, password);
  await at('provider');
  await subjectFree(execute, subject, null);
  return await advance(execute, id, "provider_subject = $2, phase = 'user_made'", [subject]);
}

async function bind(execute: Execute, run: Run, id: string, admit: Admit): Promise<Act> {
  const { ownerActor, live, act } = await locked(execute, run, id, admit);
  if (act.phase !== 'user_made' || act.provider_subject === null) return act;
  if (live.length > 0) throw new Refusal(NOT_OURS);
  await subjectFree(execute, act.provider_subject, null);
  const [login] = await execute<{ id: string }>(
    `insert into public.logins (business_id, id, provider, subject)
     values ($1, gen_random_uuid(), 'supabase', $2) returning id`,
    [run.businessId, act.provider_subject],
  );
  await execute(
    `insert into public.actor_logins (business_id, id, login_id, actor_id, active, linked_by_actor_id)
     values ($1, gen_random_uuid(), $2, $3, true, $4)`,
    [run.businessId, login?.id, run.make.agentId, ownerActor],
  );
  // A restore switches the agent back on with its new login; its delegations stay revoked.
  if (act.act === 'restore')
    await execute(
      'update public.actors set active = true, deactivated_at = null where business_id = $1 and id = $2',
      [run.businessId, run.make.agentId],
    );
  return await advance(execute, id, "login_id = $2, phase = 'bound'", [login?.id]);
}

/** The stored credential signs in, and the agent door answers as the agent, with no delegation. */
async function probe(run: Run, act: Act, password: string): Promise<void> {
  await signedIn(run);
  const gotrueUrl = run.env['GOTRUE_URL'] ?? '';
  const providerKey = run.env['SUPABASE_SERVICE_KEY'] ?? '';
  const bearer = await agentSignIn(
    { gotrueUrl, email: act.email, password, providerKey },
    () => {},
  );
  if ('because' in bearer) throw new Refusal(`${PROBE_FAILED} (the credential did not sign in)`);
  const presented = await run.verify(await bearer.current());
  if (presented === undefined || presented.subject !== act.provider_subject)
    throw new Refusal(PROBE_FAILED);
  const [clock] = await run.admin.execute<{ since: Date }>('select clock_timestamp() as since');
  const answer = await executeAgentCommand(run.runtime, run.businessId, presented, undefined, {
    command: 'task.queue',
    operationId: randomUUID(),
  });
  if (isCommandRefusal(answer) && answer.code.startsWith('AUTH_'))
    throw new Refusal(`${PROBE_FAILED} (${answer.code})`);
  const resolved = await run.admin.execute(
    `select 1 from public.authentication_attempts
      where business_id = $1 and login_id = $2 and owner = 'agent_login' and outcome = 'resolved'
        and actor_id = $3 and at >= $4`,
    [run.businessId, act.login_id, run.make.agentId, clock?.since],
  );
  if (resolved.length === 0) throw new Refusal(PROBE_FAILED);
}

async function closeAct(execute: Execute, run: Run, id: string, admit: Admit): Promise<Act> {
  const { act } = await locked(execute, run, id, admit);
  if (act.phase !== 'bound') return act;
  return await advance(
    execute,
    id,
    "phase = 'probed', probe = 'passed', closed_at = clock_timestamp()",
    [],
  );
}

/** The make, phase after phase from wherever its act stands. */
export async function makeAct(
  run: Run,
  password: string,
  at: At,
  admit: Admit = admission,
): Promise<{ act: Act; already: boolean }> {
  const reserved = await acting(
    run,
    null,
    async (execute) => await reserve(execute, run, at, admit),
  );
  if ('already' in reserved) return { act: reserved.already, already: true };
  let act = reserved;
  await at('reserved');
  if (act.phase === 'reserved') {
    const { id } = act;
    act = await acting(
      run,
      null,
      async (execute) => await provide(execute, run, id, password, { at, admit }),
    );
    await at('user_made');
  }
  if (act.phase === 'user_made') {
    const { id } = act;
    act = await acting(
      run,
      act.provider_subject,
      async (execute) => await bind(execute, run, id, admit),
    );
    await at('bound');
  }
  if (act.phase === 'bound') {
    await probe(run, act, password);
    const { id } = act;
    act = await acting(run, null, async (execute) => await closeAct(execute, run, id, admit));
  }
  return { act, already: false };
}
