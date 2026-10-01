// SPDX-License-Identifier: AGPL-3.0-only
//
// The AW-10 cases' world, on AW-01's (`broker-world.ts`): custody's real
// process and the replay provider on loopback, with the provider's faults
// injected through its modes, never through row writes. A run calls the model
// through the broker, the call fails as the provider makes it fail, the worker
// hands the run back `dropped` with the cause the broker recorded, and the
// pass runs as the API runs it (`passDeployment`) with the provider phase.

import { randomUUID } from 'node:crypto';
import { beforeAll } from 'vitest';
import { passDeployment, registerEffectLookup } from '../../apps/api/recovery-entry.ts';
import {
  readReplayLookup,
  replayAdapter,
  replayCostMinor,
  replayLookup,
  type ReplayMode,
} from '../../packages/core-connectors/src/index.ts';
import {
  callModel,
  reconcileProviderCalls,
  type Broker,
  type ModelCallRequest,
  type ModelCallResult,
} from '../../packages/core-custody/src/index.ts';
import { readCallDrops, type CallDrop } from '../../packages/core-runtime/src/index.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';

type Row = Record<string, unknown>;
import {
  appliedDetail,
  asAgent,
  asPerson,
  handbackBody,
  liveWork,
  rows,
  type Schedules,
  type Work,
} from '../runtime/schedules-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import { launched } from '../runtime/aw-08-world.ts';
import { writeAuditEvent } from '../../packages/core-commands/src/commands/audit.ts';
import { callerAudit } from '../../packages/core-commands/src/index.ts';
import {
  broker,
  caller,
  digestOf,
  noDatabase,
  requestFor,
  s,
  stepOf,
  useBrokerWorld,
  world,
} from './broker-world.ts';

export { noDatabase, s, world };

/** The broker with the replay provider's lookup declared (AW-10). */
export const faultBroker = (): Broker => ({
  ...broker,
  providers: new Map([
    [
      'replay',
      {
        build: replayAdapter,
        price: replayCostMinor,
        lookup: replayLookup,
        readLookup: readReplayLookup,
      },
    ],
  ]),
});

/** AW-01's world, with budget permission for the decider (T3d1's `openBilling`). */
export function useFaultWorld(label: string): void {
  useBrokerWorld(label);
  beforeAll(async () => {
    if (noDatabase) return;
    await openBilling(s);
  }, 60_000);
}

/** A call on `work` in `on`, through `with_`. */
export const callIn = async (
  on: Schedules,
  work: Work,
  with_: Broker = faultBroker(),
  overrides: Partial<ModelCallRequest> = {},
): Promise<ModelCallResult> => {
  await stepOf(work);
  const asked = { ...caller(work), actorId: on.agentActorId };
  // The broker's audit is written as the calling business's own agent.
  const audit: Broker['audit'] = async (tx, note) => {
    await writeAuditEvent(tx, {
      actorId: on.agentActorId,
      command: note.action,
      outcome: note.outcome,
      refusalCode: note.refusalCode,
      payloadDigest: digestOf(note.detail),
      attempted: note.outcome === 'refused' ? note.detail : null,
    });
  };
  return await callModel(on.db.app, on.business, asked, requestFor(work, overrides), {
    ...with_,
    audit,
  });
};

/**
 * Room beside the kept hold, by the person who approved the work (T2e): a
 * step proved absent keeps its first hold for a person (O6), so its
 * replacement needs room of its own.
 */
export async function room(on: Schedules, work: Work): Promise<void> {
  appliedDetail(
    await asPerson(on, {
      command: 'budget.top_up',
      operationId: randomUUID(),
      recordId: work.taskId,
      amountMinor: 2_000,
      fromMaximumMinor: 2_000,
    }),
    'budget.top_up',
  );
}

export interface Dropped {
  readonly work: Work;
  readonly result: ModelCallResult;
}

/** Live work whose model call meets `mode` through `with_`, handed back `dropped` with the cause the broker recorded. */
export async function dropped(
  mode: ReplayMode,
  on: Schedules = s,
  with_: Broker = faultBroker(),
): Promise<Dropped> {
  const work = await liveWork(on, `aw10 ${mode} ${randomUUID()}`, 2_000);
  await room(on, work);
  world.provider.mode(mode);
  const result = await callIn(on, work, with_);
  const cause = 'cause' in result ? result.cause : null;
  // A failure that is no drop is handed back as failed: the worker names no cause it lacks.
  const body = {
    ...handbackBody(work.picked),
    outcome: cause === null ? 'failed' : 'dropped',
    report:
      cause === null
        ? { summary: 'the provider failed' }
        : { summary: 'the provider failed', dropCause: cause },
  };
  appliedDetail(await asAgent(on, body, String(work.picked['credential'])), 'task.handback');
  return { work, result };
}

/**
 * A worker lost mid-call: custody took the call and never answers, and the
 * lease runs out. `providerStarted`: launched work whose worker first marked
 * the step and recorded its own provider's start (T3e1), as the real worker does.
 */
export async function workerLost(on: Schedules = s, providerStarted = false): Promise<Work> {
  const work = providerStarted
    ? await startedWork(on)
    : await liveWork(on, `aw10 lost ${randomUUID()}`, 2_000);
  await room(on, work);
  const silent: Broker = {
    ...faultBroker(),
    custody: { ...faultBroker().custody, dispatch: async () => await new Promise(() => {}) },
  };
  // A dispatched task is no longer business-internal (S3), so the call binds no field of it.
  void callIn(on, work, silent, providerStarted ? { fields: [] } : {});
  await expectStarted(on, work);
  await on.db.admin.execute(
    `update public.leases set expires_at = clock_timestamp() - interval '1 second' where id = $1`,
    [work.picked['leaseId']],
  );
  return work;
}

/** Launched work (AW-08) whose step is marked and whose provider start is recorded. */
async function startedWork(on: Schedules): Promise<Work> {
  const { taskId, plan, handedBack, picked } = await launched(on, 'aw10 started');
  const lease = { leaseId: picked['leaseId'], fence: picked['fence'] };
  for (const body of [
    { command: 'task.dispatch' },
    { command: 'task.heartbeat', providerStarting: true },
  ]) {
    const sent = { ...body, operationId: randomUUID(), ...lease };
    // eslint-disable-next-line no-await-in-loop
    appliedDetail(await asAgent(on, sent, String(picked['credential'])), body.command);
  }
  return { taskId, proposal: plan, decision: handedBack, picked };
}

async function expectStarted(on: Schedules, work: Work): Promise<void> {
  for (let tries = 0; tries < 100; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    const found = await rows(
      on,
      `select 1 from public.model_calls where lease_id = $1 and state = 'dispatched'`,
      [work.picked['leaseId']],
    );
    if (found.length > 0) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error('the silent call never started');
}

/** The reconciliation pass over `on`'s businesses, as the API runs it (`startModelBroker`), provider phase included. */
export async function pass(
  on: Schedules | readonly Schedules[] = s,
  with_: Broker = faultBroker(),
): ReturnType<typeof passDeployment> {
  const all: readonly Schedules[] = 'db' in on ? [on] : on;
  return await passDeployment(
    s.db.app,
    async (key) => await Promise.resolve(all[Number(key)]?.business),
    all.map((_, at) => String(at)),
    registerEffectLookup,
    async (database, businessId, unanswered) =>
      await reconcileProviderCalls(
        database,
        businessId as BusinessId,
        // The pass's events as the API writes them: as the agent whose call it was.
        { ...with_, audit: callerAudit },
        unanswered,
      ),
  );
}

/** The call rows of the work's run, oldest first. */
export const callsOf = async (on: Schedules, work: Work): Promise<readonly Row[]> =>
  await rows<Row>(
    on,
    `select c.id, c.state, c.drop_cause, c.fault, c.provider_code, c.drop_state, c.reconcile_mode,
            c.reconcile_note, c.outcome, c.outcome_person_id, c.reserved_minor::text as reserved,
            c.actual_minor::text as actual, (c.unknown_since is not null) as dated
       from public.model_calls c where c.lease_id = $1 order by c.accepted_at, c.id`,
    [work.picked['leaseId']],
  );

/** The task's attempts, oldest first, with their holds. */
export const attemptsOf = async (on: Schedules, work: Work): Promise<readonly Row[]> =>
  await rows<Row>(
    on,
    `select att.id, att.state, att.drop_cause, att.dispatch_marker as marked, res.state as held,
            res.held_minor::text as held_minor
       from public.attempts att
       join public.reservations res on res.business_id = att.business_id and res.id = att.reservation_id
       join public.planned_runs run on run.business_id = att.business_id and run.id = att.run_id
      where att.business_id = $1 and run.task_id = $2 order by att.created_at, att.id`,
    [on.business, work.taskId],
  );

/** The outage reports that list the task's runs, with whether each came back. */
export const toldOf = async (on: Schedules, work: Work): Promise<readonly Row[]> =>
  await rows<Row>(
    on,
    `select r.id, r.cause, o.reactivated from public.outage_reports r
       join public.outage_runs o on o.business_id = r.business_id and o.outage_id = r.id
      where r.business_id = $1 and o.task_id = $2 order by r.opened_at`,
    [on.business, work.taskId],
  );

/** The drops the task's calls carry, read as the task's people read them. */
export const dropsOf = async (on: Schedules, work: Work): Promise<readonly CallDrop[]> =>
  await on.db.app.withBusiness(on.business, async (tx) => await readCallDrops(tx, work.taskId));

/** A person records one of the three outcomes on the work's first attempt. */
export const outcome = async (
  on: Schedules,
  work: Work,
  value: string,
  as: (body: Row) => Promise<CommandResult> = async (body) => await asPerson(on, body),
): Promise<CommandResult> =>
  await as({
    command: 'budget.record_outcome',
    operationId: randomUUID(),
    recordId: work.taskId,
    attemptId: work.picked['attemptId'],
    outcome: value,
  });
