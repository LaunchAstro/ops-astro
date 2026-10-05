// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's write-off closes a hold whose call was sent and never answered:
// the call stays unknown, its outcome recorded, and nothing resolves it again.
// A stop raised on that closed hold takes no top-up, since a top-up would
// mark the hold as one that counted its open calls: the version room would
// count the written-off call again, and a late settle of it would give back
// money the envelope never carried. The end at the stop still applies.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogue, REPLAY_COMPOSE } from '../../packages/core-connectors/src/index.ts';
import type { Broker } from '../../packages/core-custody/src/index.ts';
import { COUNTED_CAUSES, countedHold } from '../../packages/core-custody/src/broker-give-back.ts';
import { settle } from '../../packages/core-custody/src/broker-settle.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { CLOUD } from '../broker/broker-world.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  codeOf,
  openSchedules,
  pickup,
  rows,
  type Schedules,
  type Work,
} from './schedules-harness.ts';
import { writeOffBody } from './t3c-harness.ts';
import {
  askOf,
  callState,
  committed,
  dispatchedCall,
  envelopeOf,
  holdsOf,
  moneyOf,
  roomyWork,
  spend,
  stampBefore,
  stopWorker,
  sweep,
  topUp,
} from './version-room-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/top-up-on-a-written-off-hold: DATABASE_URL is unset, so nothing below ran.',
  );
}

let s: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('written_off_stop', 1_000_000);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'manage');
    await grantTo(tx, s.decider, 'decide', undefined, false, 'billing');
    await grantTo(tx, s.decider, 'decide', undefined, false, 'gate');
    await installBusinessSettings(tx);
  });
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

const UNUSED = (): never => {
  throw new Error('the late settle dispatches nothing');
};
const LATE_BROKER: Broker = {
  custody: { pid: 0, dispatch: UNUSED, stderr: () => '', raw: UNUSED, kill: UNUSED, stop: UNUSED },
  operations: catalogue([REPLAY_COMPOSE]),
  providers: new Map(),
  routes: [CLOUD],
  installation: 'here',
  audit: async () => await Promise.resolve(),
};
const LATE_ANSWER = { text: 'late', model: null, usage: { inputUnits: 1, outputUnits: 1 } };

/** The broker's own settle of the written-off call, priced at `cost` by its late answer. */
async function settleLate(work: Work, callId: string, cost: number): Promise<void> {
  const operation = LATE_BROKER.operations.get(REPLAY_COMPOSE.key);
  const [call] = await rows<{ reserved: string }>(
    s,
    'select reserved_minor::text as reserved from public.model_calls where id = $1',
    [callId],
  );
  if (operation === undefined || call === undefined) throw new Error('settleLate: no call');
  const { leaseId, fence, delegationId } = work.picked;
  await settle(
    s.db.app,
    s.business,
    { actorId: s.agentActorId, delegationId: String(delegationId), attendedByPersonId: null },
    {
      leaseId: String(leaseId),
      fence: Number(fence),
      stepId: '',
      operation: operation.key,
      fields: [],
    },
    { callId, operation, route: CLOUD, reservedMinor: Number(call.reserved) },
    {
      kind: 'priced',
      answer: { ...LATE_ANSWER, providerCode: null },
      costMinor: cost,
      account: null,
      credentialKind: 'replay',
    },
    LATE_BROKER,
  );
}

async function attemptOf(reservationId: unknown): Promise<string> {
  const [found] = await rows<{ id: string }>(
    s,
    'select id from public.attempts where business_id = $1 and reservation_id = $2',
    [s.business, reservationId],
  );
  if (found === undefined) throw new Error('attemptOf: no attempt');
  return found.id;
}

/** Custody's own reading: the hold counted its open calls at their maximum. */
async function counted(reservationId: unknown): Promise<boolean | undefined> {
  const [found] = await rows<{ counted: boolean }>(
    s,
    `select ${countedHold('$3')} as counted from public.reservations r
      where r.business_id = $1 and r.id = $2`,
    [s.business, reservationId, COUNTED_CAUSES],
  );
  return found?.counted;
}

async function answersOn(runId: string): Promise<number> {
  const [found] = await rows<{ n: string }>(
    s,
    'select count(*)::text as n from public.budget_answers where business_id = $1 and run_id = $2',
    [s.business, runId],
  );
  return Number(found?.n);
}

/**
 * A person writes off the first hold at 0 while its dispatched call is held
 * unknown, so it closes at its settled 300 with the call still open. The
 * replacement holds the 200 left, spends it and stops, stamped before the
 * first hold, so picking the first hold up stops the run for room.
 */
async function stopOnWrittenOff() {
  const { work, versionId, first } = await roomyWork(s);
  await spend(s, first, 300);
  const c2 = await dispatchedCall(s, first, 200);
  // The worker's authority goes: its lease is fenced and, with c2 open, the
  // step is held unknown at the whole hold. The sweep holds c2 unknown.
  await stopWorker(s, work.picked);
  await sweep(s);
  const writtenOff = await asPerson(
    s,
    writeOffBody({ taskId: work.taskId, attemptId: await attemptOf(first) }, 0),
  );
  appliedDetail(writtenOff, 'budget.write_off');

  const second = await pickup(s, first);
  await spend(s, second['reservationId'], 200);
  await stopWorker(s, second);
  await stampBefore(s, first, second['reservationId']);
  const stopped = await asAgent(s, {
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId: first,
    leaseSeconds: 600,
  });
  return { work, versionId, first, c2, stopped, ...(await askOf(s, first)) };
}

describe.skipIf(serverUrl === undefined)('a top-up on a stop raised on a written-off hold', () => {
  it('refuses a top-up on a written-off hold whose call is still unknown, moving nothing, and lets the end apply', async () => {
    const { work, versionId, first, c2, stopped, runId, askId } = await stopOnWrittenOff();
    const before = await moneyOf(s, work, versionId);

    const topped = await topUp(s, work, first, 100);
    expect({
      stopped: codeOf(stopped),
      call: await callState(s, c2),
      code: codeOf(topped),
      answers: await answersOn(runId),
      money: await moneyOf(s, work, versionId),
      counted: await counted(first),
    }).toEqual({
      stopped: 'BUDGET_UNAVAILABLE',
      call: 'liability_unknown',
      code: 'TRANSITION_NOT_PERMITTED',
      answers: 0,
      money: before,
      counted: false,
    });

    const ended = await asPerson(s, {
      command: 'run.end_at_budget_stop',
      operationId: randomUUID(),
      recordId: work.taskId,
      runId,
      askId,
    });
    expect({
      code: codeOf(ended),
      money: await moneyOf(s, work, versionId),
      counted: await counted(first),
    }).toEqual({ code: 'applied', money: before, counted: false });
  });
});

describe.skipIf(serverUrl === undefined)('a top-up after the written-off call settles late', () => {
  it("tops up once the written-off call settles late, the settle leaving the envelope alone and the version room counting the hold at the write-off's 300", async () => {
    const { work, versionId, first, c2, stopped } = await stopOnWrittenOff();
    const before = await envelopeOf(s, work);
    await settleLate(work, c2, 150);
    const settled = { call: await callState(s, c2), envelope: await envelopeOf(s, work) };
    const topped = await topUp(s, work, first, 100);
    // The top-up's fresh hold, picked up and stopped unspent: its replacement
    // holds what the version has left, 600 less 300, 200 and nothing.
    const fresh = (await holdsOf(s, versionId)).find((hold) => hold.state === 'held');
    await stopWorker(s, await pickup(s, fresh?.id));
    const again = await asAgent(s, {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: fresh?.id,
      leaseSeconds: 600,
    });
    const holds = await holdsOf(s, versionId);
    expect({
      stopped: codeOf(stopped),
      settled,
      topped: codeOf(topped),
      again: codeOf(again),
      live: holds.filter((hold) => hold.state === 'held').map((hold) => hold.held),
      committed: committed(holds),
    }).toEqual({
      stopped: 'BUDGET_UNAVAILABLE',
      settled: { call: 'settled', envelope: before },
      topped: 'applied',
      again: 'applied',
      live: ['100'],
      committed: 600,
    });
  });
});
