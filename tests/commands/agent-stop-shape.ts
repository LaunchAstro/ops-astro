// SPDX-License-Identifier: AGPL-3.0-only
//
// A stop of an agent login, as the operator's tool will run it, written here
// as plain statements so the agent write can be raced against it: the agent's
// live delegations `for update` in id order, the agent actor `for no key
// update`, its login mappings `for update`, then the login's session-ending
// subject key exclusive; then the revocations, the switch-offs and the
// subject's ending. It takes no audit key. A leg names which of those writes
// a case makes, so each judgement the write meets after its waits is proved
// on its own.
//
// The actor is not taken `for update`. Every agent call's door records its
// attempt, whose foreign key holds the actor `for key share` until the call
// commits, and `for update` would wait on that. A stop holding the
// delegations would then wait on a write that waits on those delegations: a
// deadlock. `for no key update` passes the key share and still waits on the
// write's own `for share` of the actor.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import type { EmptyDatabase } from '../support/fresh-database.ts';
import { hold, type Held } from '../support/lock-wait-race.ts';
import { agentWorld, type AgentWorld, type PickedUp } from './agent-fixture.ts';

type Execute = AdminConnection['execute'];

export interface StopTarget {
  readonly business: string;
  readonly agentActorId: string;
  readonly subject: string;
}

/** The stop's locks, in the order it takes them. */
export const STOP_LOCKS = ['delegations', 'actor', 'mapping', 'subject'] as const;
export type StopLock = (typeof STOP_LOCKS)[number];

/** What a stop switches off: the delegations, the actor and its mapping, the sessions. */
export type StopLeg = 'delegation' | 'identity' | 'session';
export const WHOLE_STOP: readonly StopLeg[] = ['delegation', 'identity', 'session'];

const ROW_LOCKS: Readonly<Record<Exclude<StopLock, 'subject'>, string>> = {
  delegations: `select id from public.delegations
    where business_id = $1 and agent_actor_id = $2 and revoked_at is null and settled_at is null
    order by id for update`,
  actor: 'select id from public.actors where business_id = $1 and id = $2 for no key update',
  mapping: `select id from public.actor_logins where business_id = $1 and actor_id = $2 and active
    order by id for update`,
};

/** The statement and parameters that take one of the stop's locks. */
export function stopLock(target: StopTarget, lock: StopLock): readonly [string, unknown[]] {
  return lock === 'subject'
    ? [
        `select pg_advisory_xact_lock(hashtextextended('session-ending:subject:' || $1, 0))`,
        [target.subject],
      ]
    : [ROW_LOCKS[lock], [target.business, target.agentActorId]];
}

async function take(
  execute: Execute,
  target: StopTarget,
  locks: readonly StopLock[],
): Promise<void> {
  for (const lock of locks) {
    // eslint-disable-next-line no-await-in-loop -- one lock after another, in the stop's order
    await execute(...stopLock(target, lock));
  }
}

/** Takes the stop's locks from the first up to and including `through`. */
export async function lockStop(
  execute: Execute,
  target: StopTarget,
  through: StopLock,
): Promise<void> {
  await take(execute, target, STOP_LOCKS.slice(0, STOP_LOCKS.indexOf(through) + 1));
}

/** The rest of the stop's locks after `from`, then its writes. */
export async function finishStop(
  execute: Execute,
  target: StopTarget,
  legs: readonly StopLeg[] = WHOLE_STOP,
  from?: StopLock,
): Promise<void> {
  const after = from === undefined ? 0 : STOP_LOCKS.indexOf(from) + 1;
  await take(execute, target, STOP_LOCKS.slice(after));
  const parameters = [target.business, target.agentActorId];
  if (legs.includes('delegation')) {
    await execute(
      `update public.delegations
          set revoked_at = greatest(now(), granted_at), revocation_cause = 'delegation_revoked'
        where business_id = $1 and agent_actor_id = $2 and revoked_at is null and settled_at is null`,
      parameters,
    );
  }
  if (legs.includes('identity')) {
    await execute(
      `update public.actors set active = false, deactivated_at = now()
        where business_id = $1 and id = $2 and active`,
      parameters,
    );
    await execute(
      `update public.actor_logins set active = false, deactivated_at = now()
        where business_id = $1 and actor_id = $2 and active`,
      parameters,
    );
  }
  if (legs.includes('session')) {
    await execute(
      `insert into ops.ended_subject_sessions (subject_digest, kept_session)
       values (encode(sha256(convert_to($1, 'UTF8')), 'hex'), null)`,
      [target.subject],
    );
  }
}

/** A whole stop in one committed transaction. */
export async function stopNow(
  db: EmptyDatabase,
  target: StopTarget,
  legs: readonly StopLeg[] = WHOLE_STOP,
): Promise<void> {
  await db.admin.transaction(async (execute) => {
    // A stop that parks behind the write fails here rather than hanging the case.
    await execute(`set local lock_timeout = '5s'`);
    await finishStop(execute, target, legs);
  });
}

/**
 * A stop's transaction opened on a connection of its own, taking nothing yet:
 * its locks and writes run when it is let go, and its backend is known before.
 */
export async function pendingStop(db: EmptyDatabase, target: StopTarget): Promise<Held<void>> {
  return await hold(
    db,
    async (execute) => {
      await execute('select 1');
    },
    async (execute) => await finishStop(execute, target),
  );
}

/** One business with one agent that has picked up one task, signed in on a session. */
export interface StopCase {
  readonly world: AgentWorld;
  readonly picked: PickedUp;
  readonly target: StopTarget;
  call(body: Readonly<Record<string, unknown>>): Promise<CommandResult>;
  /** The agent's comment on its own task, under its delegation. */
  comment(): Promise<CommandResult>;
}

export async function stopCase(part: string): Promise<StopCase> {
  const world = await agentWorld(part, `${part.replaceAll('_', '-')}-${randomUUID().slice(0, 8)}`);
  const decider = await world.decider('decider');
  const picked = await world.pickUp(decider, 'a task the agent works while it is stopped');
  // Signed in half a minute ago, so an ending of the subject now covers it.
  const presented: VerifiedSubject = {
    provider: 'supabase',
    subject: world.agentSubject(),
    sessionId: randomUUID(),
    assurance: { level: 'aal1', signedInAt: Math.floor(Date.now() / 1000) - 30, factorAt: null },
  };
  const call = async (body: Readonly<Record<string, unknown>>): Promise<CommandResult> =>
    await executeAgentCommand(
      world.db.app,
      world.business,
      presented,
      picked.credential,
      body as never,
    );
  return {
    world,
    picked,
    target: {
      business: world.business,
      agentActorId: world.agentActorId,
      subject: presented.subject,
    },
    call,
    comment: async () =>
      await call({
        command: 'task.comment',
        operationId: randomUUID(),
        recordId: picked.taskId,
        body: 'a note written while the stop ran',
        audience: 'internal',
      }),
  };
}

/** Tracks whether a promise has settled, without awaiting it. */
export function tracked<T>(promise: Promise<T>): {
  readonly promise: Promise<T>;
  readonly settled: () => boolean;
} {
  let done = false;
  const watched = promise.finally(() => {
    done = true;
  });
  return { promise: watched, settled: () => done };
}

const poll = async <T>(look: () => Promise<T | undefined>, what: string): Promise<T> => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const seen = await look();
    if (seen !== undefined) return seen;
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await delay(10);
  }
  throw new Error(what);
};

/**
 * Whether some backend is seen parked on a lock `held` holds before `settled`
 * says the racer finished. Read from `pg_blocking_pids`, never from a sleep.
 */
export async function waitsBehind(
  db: EmptyDatabase,
  held: Held<unknown>,
  settled: () => boolean,
): Promise<'waiting' | 'finished'> {
  return await poll(async () => {
    if (settled()) return 'finished';
    const rows = await db.admin.execute<{ readonly waiting: boolean }>(
      `select exists (select 1 from pg_stat_activity a
        where a.datname = current_database() and a.wait_event_type = 'Lock'
          and $1::int = any(pg_blocking_pids(a.pid))) as waiting`,
      [held.pid],
    );
    return rows[0]?.waiting === true ? 'waiting' : undefined;
  }, 'waitsBehind: the racer neither waited nor finished');
}

/**
 * Whether the stop on backend `stop` is seen parked behind the write, which
 * itself waits on a lock `parker` holds, before `settled` says it finished.
 */
export async function stopWaitsBehindWrite(
  db: EmptyDatabase,
  stop: Held<unknown>,
  parker: Held<unknown>,
  settled: () => boolean,
): Promise<'waiting behind the write' | 'finished'> {
  return await poll(async () => {
    if (settled()) return 'finished';
    const rows = await db.admin.execute<{ readonly behind: boolean }>(
      `select exists (select 1 from pg_stat_activity w
        where w.pid = any(pg_blocking_pids($1::int))
          and $2::int = any(pg_blocking_pids(w.pid))) as behind`,
      [stop.pid, parker.pid],
    );
    return rows[0]?.behind === true ? 'waiting behind the write' : undefined;
  }, 'the stop neither waited behind the write nor finished');
}
