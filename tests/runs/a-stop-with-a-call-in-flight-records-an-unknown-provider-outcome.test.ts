// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R2, a stop racing an open call. The worker has one call dispatched
// (custody holds it at a gate) and one reserved that it never started. A stop,
// a person's `task.cancel` or the worker's own `run.end TOOL_REFUSED` through
// the real agent door, races the dispatched call's settlement on a connection
// of its own, in both orders: a third connection holds the lease row both
// need, each racer is started only once the one before it is seen waiting,
// then the holder lets go.
//
// Precedence is decided under the locks. With the call still dispatched when
// the stop commits, the attempt's one row is `unknown_provider_outcome /
// OPEN_CALL_AT_STOP`, the code the stop would have written kept in
// `stop_cause`. With the answer settled first, the row is the stop's own.
// Either way the unsent hold is released, the dispatched call's answer still
// settles and charges its observed cost, and the row never changes after.
//
// Control: the call settled before any stop, nothing reserved, then a clean
// stop records the writer's own outcome.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it as vitestIt } from 'vitest';
import { auditAs } from '../../packages/core-commands/src/commands/model-call.ts';
import { catalogue, REPLAY_COMPOSE } from '../../packages/core-connectors/src/index.ts';
import {
  reserveModelCall,
  type Broker,
  type Custody,
} from '../../packages/core-custody/src/index.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import { holdRows, liveWork, racer, rows, type Work } from '../runtime/schedules-harness.ts';
import { attemptOfLease } from './run-outcomes-read.ts';
import {
  authorityOf,
  brokerOver,
  callsOf,
  cancelTask,
  door,
  modelCall,
  named,
  noDatabase,
  outcomesOf,
  restartAndAdvance,
  runEnd,
  s,
  shapeOf,
  useStopWorld,
  world,
} from './run-stop-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useStopWorld('sol1623races');

type Stop = 'task.cancel' | 'run.end';

/** The code each stop writes when nothing is open at it. */
const OWN_CODE: Readonly<Record<Stop, string>> = {
  'task.cancel': 'TASK_CANCELLED',
  'run.end': 'TOOL_REFUSED',
};

/** Poll until the work has a call custody is holding, sent and unanswered. */
async function dispatchedOn(work: Work): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // Polling is sequential by definition.
    // eslint-disable-next-line no-await-in-loop
    const open = (await callsOf(work)).find((row) => row.state === 'dispatched');
    if (open !== undefined) return open.id;
    // eslint-disable-next-line no-await-in-loop
    await sleep(25);
  }
  throw new Error('no call was ever dispatched: the schedule was not established');
}

/** Custody waiting at a gate before it dispatches for real, until `open`. */
function gatedCustody(base: Custody = world.custody): {
  readonly custody: Custody;
  readonly open: () => void;
} {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    custody: {
      ...base,
      dispatch: async (...args: Parameters<Custody['dispatch']>) => {
        await gate;
        return await base.dispatch(...args);
      },
    },
    open: () => release?.(),
  };
}

let unsentHolds = 0;

/**
 * A call the worker reserved through the real broker and never started: the
 * worker was lost between the hold and the send. The hold is committed. Each
 * is under an operation key of its own, so a hold a stop leaves reserved
 * never takes the next case's room on the operation's concurrency.
 */
async function reserveUnsent(work: Work): Promise<string> {
  unsentHolds += 1;
  const operation = { ...REPLAY_COMPOSE, key: `model.replay_unsent_${String(unsentHolds)}` };
  const leaseId = String(work.picked['leaseId']);
  const { attemptId } = await attemptOfLease(s.db.admin, s.business, leaseId);
  const [step] = await rows<{ step_id: string }>(
    s,
    'select step_id::text as step_id from public.attempts where id = $1',
    [attemptId],
  );
  const broker: Broker = {
    ...brokerOver(),
    operations: catalogue([operation]),
    audit: auditAs(s.agentActorId),
  };
  const held = await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await reserveModelCall(
        tx,
        {
          actorId: s.agentActorId,
          delegationId: String(work.picked['delegationId']),
          attendedByPersonId: null,
        },
        {
          leaseId,
          fence: Number(work.picked['fence']),
          stepId: String(step?.step_id),
          operation: operation.key,
          fields: [{ name: 'tone', from: { recordId: work.taskId, key: 'title' } }],
        },
        broker,
      ),
  );
  if (!held.ok) throw new Error(`setup: the unsent hold was refused ${held.code}`);
  return held.reserved.callId;
}

/** Backends of this database waiting on any lock. */
async function lockWaiters(): Promise<number> {
  const [found] = await rows<{ n: string }>(
    s,
    `select count(*)::text as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`,
    [],
  );
  return Number(found?.n ?? 0);
}

/**
 * Wait until `count` backends wait on a lock, or `answered` says the racer
 * already has its answer without waiting (a door that refused it outright).
 * A schedule that establishes neither throws rather than passing quietly.
 */
async function parkedOrAnswered(count: number, answered: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    // Polling is sequential by definition.
    // eslint-disable-next-line no-await-in-loop
    if (answered() || (await lockWaiters()) >= count) return;
    // eslint-disable-next-line no-await-in-loop
    await sleep(25);
  }
  throw new Error(
    `fewer than ${String(count)} racers ever waited: the schedule was not established`,
  );
}

const fresh = async (what: string): Promise<Work> =>
  await liveWork(s, `sol1623 ${what} ${randomUUID()}`, 2_000);

/** The stop, on `database`: what it answered. */
const stopOn = async (stop: Stop, work: Work, database: Database): Promise<string> =>
  stop === 'task.cancel'
    ? await cancelTask(work, database)
    : String((await runEnd(work, OWN_CODE[stop], door(database))).body['code']);

interface Raced {
  readonly work: Work;
  readonly dispatchedId: string;
  readonly unsentId: string;
}

/**
 * One dispatched call and one unsent hold, then `stop` and the call's
 * settlement racing on connections of their own, `first` let through first.
 */
async function race(stop: Stop, first: 'stop' | 'answer'): Promise<Raced> {
  const work = await fresh(`${stop} ${first} first`);
  world.provider.mode('answer');
  const gate = gatedCustody();
  const [callDb, stopDb] = [racer(s), racer(s)];
  const pending = modelCall(work, door(callDb, brokerOver(gate.custody)));
  let answered = false;
  let stopping: Promise<string> | undefined;
  const startStop = () => {
    stopping = stopOn(stop, work, stopDb).finally(() => {
      answered = true;
    });
  };
  try {
    const dispatchedId = await dispatchedOn(work);
    const unsentId = await reserveUnsent(work);
    const holder = await holdRows(s, 'leases', [String(work.picked['leaseId'])]);
    try {
      if (first === 'stop') {
        startStop();
        await parkedOrAnswered(1, () => answered);
        const waiting = answered ? 0 : 1;
        gate.open();
        await parkedOrAnswered(waiting + 1, () => false);
      } else {
        gate.open();
        await parkedOrAnswered(1, () => false);
        startStop();
        await parkedOrAnswered(2, () => answered);
      }
    } finally {
      await holder.release();
    }
    await Promise.allSettled([stopping, pending]);
    return { work, dispatchedId, unsentId };
  } finally {
    gate.open();
    await Promise.allSettled([stopping, pending]);
    await Promise.all([callDb.close(), stopDb.close()]);
  }
}

/** What every race leaves: the unsent hold released, the answer settled and charged, the work retired. */
async function expectLedgerAfter({ work, dispatchedId, unsentId }: Raced): Promise<void> {
  const calls = new Map((await callsOf(work)).map((row) => [row.id, row]));
  expect(calls.get(unsentId)?.state, 'the unsent hold is released').toBe('released');
  expect(calls.get(dispatchedId), 'the late answer settles and charges').toMatchObject({
    state: 'settled',
    actual: '100',
  });
  expect(await authorityOf(work), 'the stop retires the work').toMatchObject({
    lease: 'released',
    cause: 'work_retired',
  });
}

/** The row, once more after a restart and the clock moving on: it never changes. */
async function expectRowKept(work: Work): Promise<void> {
  const recorded = await outcomesOf(work);
  await restartAndAdvance(work);
  expect(await outcomesOf(work), 'the row never changes after').toEqual(recorded);
}

for (const stop of ['task.cancel', 'run.end'] as const) {
  it(`${stop} committed while a call is dispatched records OPEN_CALL_AT_STOP`, async () => {
    const raced = await race(stop, 'stop');
    expect(shapeOf(await outcomesOf(raced.work)), 'the open call decides the row').toEqual([
      named('unknown_provider_outcome', 'OPEN_CALL_AT_STOP', OWN_CODE[stop]),
    ]);
    await expectLedgerAfter(raced);
    await expectRowKept(raced.work);
  });

  it(`${stop} after the racing answer settled records its own outcome`, async () => {
    const raced = await race(stop, 'answer');
    expect(shapeOf(await outcomesOf(raced.work)), 'nothing was open at the stop').toEqual([
      named('cancelled', OWN_CODE[stop]),
    ]);
    await expectLedgerAfter(raced);
    await expectRowKept(raced.work);
  });

  it(`control: calls settled first, then a clean ${stop} records the writer's own outcome`, async () => {
    const work = await fresh(`${stop} control`);
    world.provider.mode('answer');
    const answer = await modelCall(work);
    expect(answer.body['detail'], 'setup: the call settled').toMatchObject({ state: 'settled' });

    await stopOn(stop, work, s.db.app);
    expect(shapeOf(await outcomesOf(work)), 'the writer records its own outcome').toEqual([
      named('cancelled', OWN_CODE[stop]),
    ]);
    expect(await callsOf(work)).toMatchObject([{ state: 'settled', actual: '100' }]);
    await expectRowKept(work);
  });
}
