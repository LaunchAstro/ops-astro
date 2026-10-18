// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R1: the world the stop writers' proofs share, one per test file. A
// schedules database with work really proposed, approved and picked up,
// custody's real process and the replay provider on loopback, and the real
// HTTP boundary with the agent door and `model.call` mounted over them. Every
// worker act goes through that door on the agent's own token and the
// delegation its pickup minted; `run.end` is posted there too, so a tree that
// has no such verb answers it at the door and records nothing. Outcomes are
// read only through `run-outcomes-read.ts`.
//
// The bindings are live: `s` and `world` are set by `useStopWorld`'s
// beforeAll and read by the cases after it.

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { afterAll, beforeAll } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { createBusinessResolver } from '../../apps/api/server.ts';
import { sweepDeployment } from '../../apps/api/recovery-entry.ts';
import {
  executeAgentCommand,
  executeCommand,
  executeRead,
  modelCallExecutor,
} from '../../packages/core-commands/src/index.ts';
import type { ModelBroker } from '../../packages/core-commands/src/commands/model-call.ts';
import {
  catalogue,
  REPLAY_COMPOSE,
  REPLAY_NOTHING_HAPPENED,
  readReplayAnswer,
  replayAdapter,
  replayCostMinor,
  type ModelOperationDeclaration,
} from '../../packages/core-connectors/src/index.ts';
import type { BrokerRoute, Custody } from '../../packages/core-custody/src/index.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import { replayRecordedTransitions } from '../../packages/core-runtime/src/index.ts';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/index.ts';
import { openCustodyWorld, type CustodyWorld } from '../custody/custody-world.ts';
import {
  asPerson,
  codeOf,
  openSchedules,
  rows,
  type Schedules,
  type Work,
} from '../runtime/schedules-harness.ts';
import { ISSUER, tokenFor } from '../api/fixture.ts';
import { testSignIn } from '../support/sign-in.ts';
import { attemptOfLease, outcomesOfAttempt, type OutcomeRow } from './run-outcomes-read.ts';

export const noDatabase: boolean = databaseUrlFromEnvironment() === undefined;

export let s: Schedules;
export let world: CustodyWorld;
let key: string;
let agentToken: string;

/**
 * The replay operation, answering as a local runner at its plan limit: the
 * stand-in's own nothing-happened answer is read as `LOCAL_PLAN_LIMIT`, which
 * the declaration names among its nothing-happened codes. The replay provider
 * has no such script of its own, so the declaration is the seam; custody,
 * the provider's answer and settlement are the real ones.
 */
export const PLAN_LIMITED: ModelOperationDeclaration = {
  ...REPLAY_COMPOSE,
  key: 'model.replay_plan_limited',
  answer: (body) => {
    const read = readReplayAnswer(body);
    return read?.providerCode === REPLAY_NOTHING_HAPPENED
      ? { ...read, providerCode: 'LOCAL_PLAN_LIMIT' }
      : read;
  },
  nothingHappened: [REPLAY_NOTHING_HAPPENED, 'http_429', 'LOCAL_PLAN_LIMIT'],
};

const ROUTE: BrokerRoute = {
  key: 'replay',
  reach: 'cloud',
  provider: 'replay',
  credentialRef: 'replay_key',
  credentialKind: 'api_key',
  installation: 'here',
  ceiling: 1_000,
};

/** The deployment's broker over `custody`: the world's own unless a case wraps it. */
export const brokerOver = (custody: Custody = world.custody): ModelBroker => ({
  custody,
  operations: catalogue([REPLAY_COMPOSE, PLAN_LIMITED]),
  providers: new Map([['replay', { build: replayAdapter, price: replayCostMinor }]]),
  routes: [ROUTE],
  installation: 'here',
});

/** The real HTTP boundary on `database`, with `model.call` over `broker`. */
export const door = (database: Database = s.db.app, broker: ModelBroker = brokerOver()): Hono =>
  createApi({
    database,
    verify: createSupabaseVerifier(testSignIn(ISSUER)),
    resolveBusiness: createBusinessResolver(s.db.admin),
    executeRead,
    executeCommand,
    executeAgentCommand,
    executeModelCall: modelCallExecutor(broker),
  });

export interface Answer {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

/** A POST through the agent door, as the worker holding `work` sends it. */
export async function asWorker(
  app: Hono,
  work: Work,
  path: string,
  body: Readonly<Record<string, unknown>>,
): Promise<Answer> {
  const response = await app.fetch(
    new Request(`http://api.test/api/a/b/${key}/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${agentToken}`,
        [DELEGATION_HEADER]: String(work.picked['credential']),
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { text };
  }
  return { status: response.status, body: parsed as Answer['body'] };
}

/** `model.call` on the run's own task, bound to its title (S3). */
export const modelCallBody = (
  work: Work,
  operation: string = REPLAY_COMPOSE.key,
  operationId: string = randomUUID(),
): Readonly<Record<string, unknown>> => ({
  operationId,
  leaseId: work.picked['leaseId'],
  fence: work.picked['fence'],
  operation,
  fields: [{ name: 'tone', from: { recordId: work.taskId, key: 'title' } }],
});

export const modelCall = async (
  work: Work,
  app: Hono = door(),
  body: Readonly<Record<string, unknown>> = modelCallBody(work),
): Promise<Answer> => await asWorker(app, work, 'model/call', body);

/** The worker's own end, `run.end`, on the lease it holds. The server derives the outcome. */
export const runEndBody = (
  work: Work,
  endCode: string,
  operationId: string = randomUUID(),
): Readonly<Record<string, unknown>> => ({
  operationId,
  leaseId: work.picked['leaseId'],
  fence: work.picked['fence'],
  endCode,
});

export const runEnd = async (
  work: Work,
  endCode: string,
  app: Hono = door(),
  operationId: string = randomUUID(),
): Promise<Answer> => await asWorker(app, work, 'run/end', runEndBody(work, endCode, operationId));

/** A person's cancellation of the work's task, on `database`. Its code, or `applied`. */
export const cancelTask = async (work: Work, database: Database = s.db.app): Promise<string> =>
  codeOf(
    await asPerson(
      s,
      {
        command: 'task.cancel',
        operationId: randomUUID(),
        recordId: work.taskId,
        lineageId: work.proposal['lineageId'],
        reason: 'the client withdrew the request',
      },
      database,
    ),
  );

/** Every outcome recorded for the attempt the work's lease serves. */
export async function outcomesOf(work: Work): Promise<readonly OutcomeRow[]> {
  const { attemptId } = await attemptOfLease(
    s.db.admin,
    s.business,
    String(work.picked['leaseId']),
  );
  return await outcomesOfAttempt(s.db.admin, s.business, attemptId);
}

/** The outcome as a case names it: the outcome, its code and any stop cause. */
export const named = (
  outcome: string,
  endCode: string,
  stopCause: string | null = null,
): Pick<OutcomeRow, 'outcome' | 'end_code' | 'stop_cause'> => ({
  outcome,
  end_code: endCode,
  stop_cause: stopCause,
});

export const shapeOf = (found: readonly OutcomeRow[]): ReturnType<typeof named>[] =>
  found.map((row) => named(row.outcome, row.end_code, row.stop_cause));

export interface CallRow {
  readonly id: string;
  readonly state: string;
  readonly reserved: string;
  readonly actual: string | null;
  readonly observed: string | null;
}

/** The lease's model calls, oldest first, refused steps left out. */
export const callsOf = async (work: Work): Promise<readonly CallRow[]> =>
  await rows<CallRow>(
    s,
    `select id::text as id, state, reserved_minor::text as reserved,
            actual_minor::text as actual, observed_minor::text as observed
       from public.model_calls where lease_id = $1 and state <> 'refused'
      order by accepted_at, id`,
    [work.picked['leaseId']],
  );

export interface Authority {
  readonly lease: string;
  readonly cause: string | null;
  readonly run: string;
}

/** The lease, its delegation and its run, as a stop leaves them. */
export async function authorityOf(work: Work): Promise<Authority> {
  const [found] = await rows<Authority>(
    s,
    `select l.state as lease, d.revocation_cause as cause, run.state as run
       from public.leases l
       join public.delegations d on d.id = l.delegation_id
       join public.planned_runs run on run.id = l.run_id
      where l.id = $1`,
    [work.picked['leaseId']],
  );
  if (found === undefined) throw new Error('the work has no lease');
  return found;
}

/**
 * A worker restart and the clock moving on: the recorded transitions replayed,
 * the deployment's sweep, then the lease's expiry put behind the database
 * clock and the sweep again.
 */
export async function restartAndAdvance(work: Work): Promise<void> {
  await s.db.app.withBusiness(s.business, async (tx) => await replayRecordedTransitions(tx));
  const resolve = async (businessKey: string) =>
    await Promise.resolve(businessKey === 'home' ? s.business : undefined);
  await sweepDeployment(s.db.app, resolve, ['home']);
  await s.db.admin.execute(
    `update public.leases set expires_at = greatest(acquired_at, clock_timestamp() - interval '1 second')
      where id = $1`,
    [work.picked['leaseId']],
  );
  await sweepDeployment(s.db.app, resolve, ['home']);
}

/** Opens the world before the file's cases and closes it after them. */
export function useStopWorld(label: string): void {
  beforeAll(async () => {
    if (noDatabase) return;
    s = await openSchedules(label, 1_000_000);
    world = await openCustodyWorld();
    const [business] = await s.db.admin.execute<{ key: string }>(
      'select key from public.businesses where id = $1',
      [s.business],
    );
    key = String(business?.key);
    agentToken = await tokenFor(s.agent.subject);
  }, 180_000);

  afterAll(async () => {
    await world?.close();
    await s?.db.drop();
  });
}
