// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the #1623 R1 door proofs share, one per test file: a schedules
// database with work really proposed, approved and picked up, custody's real
// process and the replay provider on loopback, and the real HTTP boundary with
// the broker mounted. The door has a connection of its own, so a call parked
// at a lock never queues the fixture's own work behind it in the client.
//
// The agent signs in with a session of its own for each case, so a case can
// end it on an independent connection while its call waits. `s` and `world`
// are live bindings, set by `useDoorWorld`'s beforeAll.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Hono } from 'hono';
import { afterAll, beforeAll } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { createBusinessResolver } from '../../apps/api/server.ts';
import {
  executeAgentCommand,
  executeCommand,
  executeRead,
  modelCallExecutor,
  type ModelBroker,
} from '../../packages/core-commands/src/index.ts';
import {
  catalogue,
  REPLAY_COMPOSE,
  replayAdapter,
  replayCostMinor,
} from '../../packages/core-connectors/src/index.ts';
import type { ModelCallField } from '../../packages/core-custody/src/index.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import { endProviderSession } from '../../packages/core-records/src/identity/sessions.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/index.ts';
import { ISSUER, post, type Answer } from '../api/fixture.ts';
import { CLOUD, ONE_AT_A_TIME } from '../broker/broker-world.ts';
import { openCustodyWorld, type CustodyWorld } from '../custody/custody-world.ts';
import {
  barrier,
  openSchedules,
  racer,
  rows,
  scalar,
  type Holder,
  type Schedules,
  type Work,
} from '../runtime/schedules-harness.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { signBearer, testSignIn } from '../support/sign-in.ts';
import { attemptOfLease, outcomesOfAttempt, type OutcomeRow } from './run-outcomes-read.ts';

export const noDatabase: boolean = databaseUrlFromEnvironment() === undefined;

export let s: Schedules;
export let world: CustodyWorld;
let door: Hono;
let key: string;
let doorConnection: Database;

export const doorBroker = (): ModelBroker => ({
  custody: world.custody,
  // One call at a time per business: a single hold in flight reaches its ceiling.
  operations: catalogue([REPLAY_COMPOSE, ONE_AT_A_TIME]),
  providers: new Map([['replay', { build: replayAdapter, price: replayCostMinor }]]),
  routes: [CLOUD],
  installation: 'here',
});

/** Opens the world before the file's cases and closes it after them. */
export function useDoorWorld(label: string): void {
  beforeAll(async () => {
    if (noDatabase) return;
    s = await openSchedules(label, 1_000_000);
    world = await openCustodyWorld();
    const [business] = await rows<{ key: string }>(
      s,
      'select key from public.businesses where id = $1',
      [s.business],
    );
    key = String(business?.key);
    doorConnection = racer(s);
    door = createApi({
      database: doorConnection,
      verify: createSupabaseVerifier(testSignIn(ISSUER)),
      resolveBusiness: createBusinessResolver(s.db.admin),
      executeRead,
      executeCommand,
      executeAgentCommand,
      executeModelCall: modelCallExecutor(doorBroker()),
    });
  }, 180_000);
  afterAll(async () => {
    await doorConnection?.close();
    await world?.close();
    await s?.db.drop();
  });
}

/** The agent's bearer for a session of its own, which this case alone may end. */
export interface SignedIn {
  readonly token: string;
  readonly sessionId: string;
}

export async function signedIn(): Promise<SignedIn> {
  const sessionId = randomUUID();
  const exp = Math.floor(Date.now() / 1000) + 600;
  const claims = { sub: s.agent.subject, aud: 'authenticated', iss: ISSUER, role: 'authenticated' };
  return { token: await signBearer({ ...claims, exp, session_id: sessionId }), sessionId };
}

export const leaseOf = (work: Work): string => String(work.picked['leaseId']);
export const delegationOf = (work: Work): string => String(work.picked['delegationId']);

export interface Sent extends Readonly<Record<string, unknown>> {
  readonly operationId: string;
}

/** The call's one field, bound to the run's own task, which a person entered (S3). */
export const boundToTask = (work: Work): readonly ModelCallField[] => [
  { name: 'tone', from: { recordId: work.taskId, key: 'title' } },
];

/** A `model.call` body on the work's lease. */
export const callBody = (work: Work, operation: string = REPLAY_COMPOSE.key): Sent => ({
  operationId: randomUUID(),
  leaseId: work.picked['leaseId'],
  fence: work.picked['fence'],
  operation,
  fields: boundToTask(work),
});

/** A POST on the agent prefix, under the work's delegation and the session's bearer. */
export async function asAgent(
  path: '/model/call' | '/run/end',
  work: Work,
  body: Readonly<Record<string, unknown>>,
  as: SignedIn,
): Promise<Answer> {
  return await post(door, `/api/a/b/${key}${path}`, body, {
    authorization: `Bearer ${as.token}`,
    [DELEGATION_HEADER]: String(work.picked['credential']),
  });
}

/**
 * `act` on an independent connection, held open until released. An ending
 * held so keeps its session key, and a judgement that asks for that key
 * waits for the ending to commit.
 */
export async function independently(act: (tx: TenantQuery) => Promise<unknown>): Promise<Holder> {
  const other = racer(s);
  const acted = barrier();
  const gate = barrier();
  const done = other.withBusiness(s.business, async (tx) => {
    await act(tx);
    acted.release();
    await gate.held;
  });
  await Promise.race([acted.held, done]);
  return {
    async release() {
      gate.release();
      await done;
      await other.close();
    },
  };
}

/** End the session on an independent connection and hold the ending open until released. */
export const holdEnding = async (sessionId: string): Promise<Holder> =>
  await independently(async (tx) => await endProviderSession(tx, sessionId));

/** End the session on an independent connection, and commit. */
export async function endSession(sessionId: string): Promise<void> {
  await (await holdEnding(sessionId)).release();
}

/** Backends parked on a row lock in `table`, or on an advisory lock, read as `awaitParked` reads them. */
const parkedOn = async (table: string): Promise<number> =>
  await scalar(
    s,
    `select count(distinct a.pid)::text as n
       from pg_stat_activity a
       join pg_locks l on l.pid = a.pid
       left join pg_class c on c.oid = l.relation
      where a.datname = current_database() and a.wait_event_type = 'Lock'
        and (($1 = 'advisory' and l.locktype = 'advisory' and not l.granted)
          or (l.locktype = 'tuple' and c.relname = $1))`,
    [table],
  );

/**
 * Whether `count` backends parked on `table` before `answer` came back. One
 * that answers without waiting reads as not parked, so the case judges the
 * answer it gave rather than failing on the schedule.
 */
export async function parkedUnlessAnswered(
  answer: Promise<unknown>,
  table: string,
  count: number,
): Promise<boolean> {
  let answered = false;
  void answer
    .catch(() => null)
    .finally(() => {
      answered = true;
    });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (answered) return false;
    // Polling is sequential by definition.
    // eslint-disable-next-line no-await-in-loop
    if ((await parkedOn(table)) >= count) return true;
    // eslint-disable-next-line no-await-in-loop
    await delay(25);
  }
  throw new Error(`the call neither answered nor parked on ${table}`);
}

/** What the stop leaves on the rows, and the money, for one piece of work. */
export interface Durable {
  readonly outcomes: readonly OutcomeRow[];
  readonly lease: string;
  readonly delegationRevoked: boolean;
  readonly revocationCause: string | null;
  readonly run: string;
  readonly calls: readonly { readonly state: string; readonly refusal_code: string | null }[];
  readonly asks: number;
  readonly reservation: string;
  readonly reservationHeldMinor: number;
  readonly envelopeHeldMinor: number;
  readonly envelopeActualMinor: number;
}

export async function durable(work: Work): Promise<Durable> {
  const { attemptId } = await attemptOfLease(s.db.admin, s.business, leaseOf(work));
  const [row] = await rows<Omit<Durable, 'outcomes'>>(
    s,
    `select l.state as lease, d.revoked_at is not null as "delegationRevoked",
            d.revocation_cause as "revocationCause", run.state as run, r.state as reservation,
            r.held_minor::int as "reservationHeldMinor", env.held_minor::int as "envelopeHeldMinor",
            env.actual_minor::int as "envelopeActualMinor",
            (select count(*)::int from public.budget_asks k
              where k.business_id = l.business_id and k.run_id = l.run_id) as asks,
            (select coalesce(json_agg(json_build_object('state', c.state, 'refusal_code',
                    c.refusal_code) order by c.accepted_at), '[]') from public.model_calls c
              where c.business_id = l.business_id and c.lease_id = l.id) as calls
       from public.leases l
       join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
       join public.planned_runs run on run.business_id = l.business_id and run.id = l.run_id
       join public.reservations r on r.business_id = l.business_id and r.id = l.reservation_id
       join public.task_envelopes env on env.business_id = r.business_id and env.id = r.envelope_id
      where l.business_id = $1 and l.id = $2`,
    [s.business, leaseOf(work)],
  );
  if (row === undefined) throw new Error('the work has no lease row');
  return { outcomes: await outcomesOfAttempt(s.db.admin, s.business, attemptId), ...row };
}

/** The register's rows for one operation id. */
export const registered = async (
  operationId: string,
): Promise<readonly { outcome: string; result: Readonly<Record<string, unknown>> }[]> =>
  await rows(
    s,
    'select outcome, result from public.operations where business_id = $1 and operation_id = $2',
    [s.business, operationId],
  );

export interface AuditRow {
  readonly command: string;
  readonly outcome: string;
  readonly refusal_code: string | null;
  readonly operation_id: string | null;
}

/** From the audit chain's last position: a reader of the events the case caused since, in order. */
export async function auditFromHere(): Promise<() => Promise<readonly AuditRow[]>> {
  const mark = await scalar(
    s,
    'select coalesce(max(seq), 0)::text as n from public.audit_events where business_id = $1',
    [s.business],
  );
  return async () =>
    await rows(
      s,
      `select command, outcome, refusal_code, operation_id from public.audit_events
        where business_id = $1 and seq > $2 order by seq`,
      [s.business, mark],
    );
}
