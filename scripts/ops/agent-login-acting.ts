// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent login tool's acting transactions and admission (agent-login.ts).
// Each acting transaction, on the owner login, takes in this order: the
// agent's lock; the new subject's lock when it binds; the operator's grant
// held for share on the runtime login while the operator is judged again (the
// bearer, the grant over the whole business, the session); the agent actor;
// the owner's membership and person actor; the agent's mappings; the act row.
// A run that loses the operator, the session or the owner during a wait stops
// before its next write or provider call.

import {
  advisoryLock,
  checkAuthority,
  lockLoginFactors,
  OPERATIONS_MANAGE,
  resolveLogin,
  subjectsOf,
  type AdminConnection,
  type BusinessId,
  type Database,
  type VerifiedSubject,
} from '../../packages/core-records/src/index.ts';
import { sessionEndedHeld } from '../../packages/core-records/src/identity/sessions.ts';
import type { Gate } from './operator.ts';
import { businessOf } from './operator-runtime.ts';
import { Refusal } from './staging-reset.ts';

export type Execute = AdminConnection['execute'];

/** What a make is asked to do, read before anything connects. */
export interface Make {
  readonly agentId: string;
  readonly local: string;
  readonly domain: string;
  readonly production: boolean;
}

/** One row of `ops.agent_login_acts`, as make reads it. */
export interface Act {
  readonly id: string;
  readonly act: string;
  readonly generation: number;
  readonly email: string;
  readonly provider_subject: string | null;
  readonly login_id: string | null;
  readonly closed_at: Date | null;
}

export interface Run {
  readonly env: Readonly<Record<string, string>>;
  readonly make: Make;
  readonly gate: Extract<Gate, { ok: true }>;
  readonly businessId: BusinessId;
  readonly admin: AdminConnection;
  readonly runtime: Database;
  readonly verify: (token: string) => Promise<VerifiedSubject | undefined>;
}

const NO_LONGER =
  'no longer the operator: the grant of operations:manage over the whole business, ' +
  'the sign-in or its session is gone, so this step was not taken';
const NOT_OURS = 'the agent already has a live login this tool did not make';
const OWNER_LEFT =
  "the agent's owner has no active membership and person actor: " +
  "an agent whose owner's access ended is stopped, never made";
const ROLLBACK = Symbol('rollback');
const NOTHING = async (): Promise<void> => {};

const KEY = [OPERATIONS_MANAGE.collection, OPERATIONS_MANAGE.action];
/**
 * Every live grant of the key any of the session's subjects holds (the
 * person's and the actor's, as the gate accepts either), with the grants it
 * stands on, held for share: its revocation waits until the step commits.
 */
const HELD_GRANTS = `
  with recursive held as (
    select id, parent_grant_id from public.grants
     where subject_id = any($1::uuid[]) and collection = $2 and action = $3 and revoked_at is null
    union
    select g.id, g.parent_grant_id from public.grants g join held h on g.id = h.parent_grant_id
  )
  select id from public.grants where id in (select id from held) order by id for share`;

/** Whether the operator still holds the grant, the sign-in and the session, read in `tx`. */
async function stillOperator(
  tx: Parameters<Parameters<Database['withBusiness']>[1]>[0],
  run: Run,
  presented: VerifiedSubject,
): Promise<boolean> {
  const session = await resolveLogin(tx, presented);
  if ('refused' in session || session.personId !== run.gate.operator.personId) return false;
  const subjects = subjectsOf(session);
  await tx.query(HELD_GRANTS, [subjects.map((subject) => subject.id), ...KEY]);
  const scope = { kind: 'business', id: null } as const;
  const decision = await checkAuthority(tx, subjects, { ...OPERATIONS_MANAGE, scope });
  return decision.ok && !(await sessionEndedHeld(tx, presented));
}

/**
 * The operator judged again on the runtime login, holding their grant for
 * share and their session's ending keys shared until the returned release:
 * a revocation or an ending begun after this waits until the step commits.
 */
async function holdOperator(run: Run, presented: VerifiedSubject): Promise<() => Promise<void>> {
  const gates = { release: (): void => {}, taken: (_why?: unknown): void => {} };
  const released = new Promise<void>((resolve) => {
    gates.release = resolve;
  });
  const ready = new Promise<void>((resolve, reject) => {
    gates.taken = (why) => (why === undefined ? resolve() : reject(why as Error));
  });
  const hold = run.runtime.withBusiness(run.businessId, async (tx) => {
    if (!(await stillOperator(tx, run, presented))) throw new Refusal(NO_LONGER);
    gates.taken();
    await released;
    throw ROLLBACK;
  });
  const ended = hold.catch((error: unknown) => {
    if (error !== ROLLBACK) gates.taken(error);
  });
  try {
    await ready;
  } catch (error) {
    await ended;
    throw error;
  }
  return async () => {
    gates.release();
    await ended;
  };
}

/**
 * The operator's bearer verified now, its expiry and its session's absolute
 * limit included; refused as no longer the operator. Asked after every wait
 * and before every write or provider call.
 */
export async function signedIn(run: Run): Promise<VerifiedSubject> {
  const presented = await run.verify(run.env['OPS_ASTRO_TOKEN'] ?? '');
  if (presented === undefined) throw new Refusal(NO_LONGER);
  return presented;
}

async function actOnce<T>(
  run: Run,
  subject: string | null,
  body: (execute: Execute) => Promise<T>,
): Promise<T> {
  // On the owner login as the gate resolved it, before the transaction takes its one connection.
  if ((await businessOf(run.admin, run.gate.operator.business)) !== run.businessId)
    throw new Refusal('OPS_ASTRO_BUSINESS no longer names the business the gate checked');
  let release = NOTHING;
  try {
    return await run.admin.transaction(async (execute) => {
      const tx = { businessId: run.businessId, query: execute };
      await execute(`select set_config('app.business_id', $1, true)`, [run.businessId]);
      await advisoryLock(tx, `agent-login:${run.businessId}:${run.make.agentId}`);
      if (subject !== null) await lockLoginFactors(tx, subject);
      // The bearer is judged after each wait, never carried across one: it may expire meanwhile.
      release = await holdOperator(run, await signedIn(run));
      await signedIn(run);
      const done = await body(execute);
      // After the step's own row locks, before its writes commit.
      await signedIn(run);
      return done;
    });
  } finally {
    await release();
  }
}

/** One acting transaction; a deadlock or a serialisation failure retries it once. */
export async function acting<T>(
  run: Run,
  subject: string | null,
  body: (execute: Execute) => Promise<T>,
): Promise<T> {
  try {
    return await actOnce(run, subject, body);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== '40P01' && code !== '40001') throw error;
    return await actOnce(run, subject, body);
  }
}

/** The agent actor and its owner, locked in order; the owner's person actor links the login. */
export async function admitted(
  execute: Execute,
  run: Run,
): Promise<{ ownerActor: string; name: string }> {
  const [agent] = await execute<{
    kind: string;
    active: boolean;
    display_name: string | null;
    owner_person_id: string | null;
  }>(
    `select kind, active, display_name, owner_person_id from public.actors
      where business_id = $1 and id = $2 for update`,
    [run.businessId, run.make.agentId],
  );
  if (agent === undefined)
    throw new Refusal(`--agent is not an agent of ${run.gate.operator.business}`);
  if (agent.kind !== 'agent') throw new Refusal('--agent names a person, not an agent');
  if (!agent.active) throw new Refusal('the agent is not active');
  if (agent.display_name === null) throw new Refusal('the agent has no name for its custody item');
  const memberships = await execute<{ active: boolean }>(
    'select active from public.memberships where business_id = $1 and person_id = $2 order by id for share',
    [run.businessId, agent.owner_person_id],
  );
  const [person] = await execute<{ id: string }>(
    `select id from public.actors where business_id = $1 and person_id = $2 and kind = 'person'
        and active order by id for share`,
    [run.businessId, agent.owner_person_id],
  );
  if (!memberships.some((row) => row.active) || person === undefined) throw new Refusal(OWNER_LEFT);
  return { ownerActor: person.id, name: agent.display_name };
}

/** The agent's mappings, locked; the live ones' logins. */
export async function liveLogins(execute: Execute, run: Run): Promise<string[]> {
  const rows = await execute<{ login_id: string; active: boolean }>(
    `select login_id, active from public.actor_logins where business_id = $1 and actor_id = $2
      order by id for update`,
    [run.businessId, run.make.agentId],
  );
  return rows.filter((row) => row.active).map((row) => row.login_id);
}

/** Refused when the subject is a login of any business, other than the act's own. */
export async function subjectFree(
  execute: Execute,
  subject: string,
  own: string | null,
): Promise<void> {
  const rows = await execute(
    "select 1 from public.logins where provider = 'supabase' and subject = $1 and id is distinct from $2",
    [subject, own],
  );
  if (rows.length > 0) throw new Refusal("the provider's user is already a login of a business");
}

/** What admission decides: resume the open act, or reserve a new generation with these values. */
export type Admission =
  { readonly open: Act } | { readonly fresh: { readonly email: string; readonly item: string } };

/**
 * A make's admission: an active agent whose owner is active, with
 * no live mapping but its open act's own, an address no other act holds, and
 * a stamped subject that no business's login holds but this act's.
 */
export async function admission(execute: Execute, run: Run): Promise<Admission> {
  const { name } = await admitted(execute, run);
  const live = await liveLogins(execute, run);
  const acts = await execute<Act>(
    `select * from ops.agent_login_acts where business_id = $1 and agent_actor_id = $2
      order by created_at for update`,
    [run.businessId, run.make.agentId],
  );
  const open = acts.find((act) => act.closed_at === null);
  const { local, domain, production } = run.make;
  const email = `${local}+g${open?.generation ?? 1}@${domain}`;
  if (live.some((login) => login !== open?.login_id)) throw new Refusal(NOT_OURS);
  const taken = await execute(
    'select 1 from ops.agent_login_acts where lower(email) = lower($1) and id is distinct from $2',
    [email, open?.id ?? null],
  );
  if (taken.length > 0) throw new Refusal('the address is already used by another act');
  if (open !== undefined) {
    if (open.email !== email) throw new Refusal('--email is not the address of the open act');
    if (open.provider_subject !== null)
      await subjectFree(execute, open.provider_subject, open.login_id);
    return { open };
  }
  if (acts.some((act) => act.act === 'make')) throw new Refusal('the agent was made already');
  const item = `Ops Astro ${production ? 'Production' : 'Staging'} - ${name} Agent Sign-in g1`;
  return { fresh: { email, item } };
}
