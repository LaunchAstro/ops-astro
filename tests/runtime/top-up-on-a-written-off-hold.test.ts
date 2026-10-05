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
import { COUNTED_CAUSES, countedHold } from '../../packages/core-custody/src/broker-give-back.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
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
} from './schedules-harness.ts';
import { writeOffBody } from './t3c-harness.ts';
import {
  askOf,
  callState,
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

/** A model call the broker sent on the hold under its lease, never answered; its id. */
async function dispatchedCall(reservationId: unknown, reserved: number): Promise<string> {
  const id = randomUUID();
  await s.db.admin.execute(
    `insert into public.model_calls
       (business_id, id, run_id, step_id, lease_id, version_id, reservation_id, operation_key,
        route_key, route_reach, credential_kind, state, reserved_minor, started_at)
     select r.business_id, $2, r.run_id, a.step_id, r.lease_id, r.version_id, r.id,
            'written_off_dispatched', 'replay', 'local', 'replay', 'dispatched', $3,
            clock_timestamp()
       from public.reservations r
       join public.attempts a on a.business_id = r.business_id and a.reservation_id = r.id
      where r.id = $1`,
    [reservationId, id, reserved],
  );
  return id;
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
  const c2 = await dispatchedCall(first, 200);
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
    expect(codeOf(ended)).toBe('applied');
  });
});
