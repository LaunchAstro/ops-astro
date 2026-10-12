// SPDX-License-Identifier: AGPL-3.0-only
//
// A budget top-up (T2e) is a money action (C59). The door judges money
// protection and the caller's step-up before the top-up waits for its cap,
// envelope and task locks; the top-up judges them again once those locks are
// held, in one statement that reads the setting and the clock together. So a
// top-up that waited on its cap is refused `STEP_UP_REQUIRED`, and raises
// nothing, when protection was switched on while it waited, or when its
// second factor aged out of the window while it waited.
//
// Each race holds the cap row `for update` on a connection of its own, sees
// the top-up wait on that holder, makes its change, and lets go. The refusal
// holds no operation id, so the same attempt sent again once stepped up is
// judged afresh, applied once, and answered as itself after that.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import {
  MONEY_STEP_UP_SETTING,
  STEP_UP_WINDOW_SECONDS,
} from '../../packages/core-records/src/authority/step-up.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/verified-subject.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  blockedBefore,
  holdRow,
  instantOf,
  waitPast,
  waiterOf,
} from '../support/lock-wait-race.ts';
import { codeOf } from '../runtime/schedules-harness.ts';
import { MAXIMUM, SMALL, openTopUpWorld, type TopUpWorld } from '../runtime/t2e-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

let world: TopUpWorld;
const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await openTopUpWorld('topupprotect');
}, 180_000);

afterAll(async () => await world?.s.db.drop());

const protection = async (on: boolean): Promise<void> => {
  await world.s.db.admin.execute(
    `update public.business_settings set value = $3::text::jsonb
      where business_id = $1 and key = $2`,
    [world.s.business, MONEY_STEP_UP_SETTING, JSON.stringify(on)],
  );
};

const databaseNow = async (): Promise<number> => {
  const clock = await world.s.db.admin.execute<{ readonly now: number }>(
    'select floor(extract(epoch from clock_timestamp()))::float8 as now',
  );
  return Number(clock[0]?.now);
};

/** The decider, signed in now, whose second factor was given at `factorAt`. */
const factorAt = (at: number, now: number): VerifiedSubject => ({
  ...world.s.decider.presented,
  assurance: { level: 'aal2', signedInAt: now, factorAt: at },
});

/** A top-up of the planned task, sent as `who` while its cap row is held. */
const parkedTopUp = async (who: VerifiedSubject) => {
  const { taskId } = await world.planned();
  const body = {
    command: 'budget.top_up',
    operationId: randomUUID(),
    recordId: taskId,
    amountMinor: SMALL,
    fromMaximumMinor: MAXIMUM,
  } as const;
  const held = await holdRow(
    world.s.db,
    'select id from public.budget_caps where id = $1 for update',
    [world.s.capId],
  );
  const topping = executeCommand(world.s.db.app, world.s.business, who, 'api', body as never);
  return { taskId, body, held, topping };
};

it('a top-up admitted with protection off is refused when protection is switched on while it waits on the cap', async () => {
  const now = await databaseNow();
  await protection(false);
  const stale = factorAt(now - 2 * STEP_UP_WINDOW_SECONDS, now);
  const { taskId, body, held, topping } = await parkedTopUp(stale);
  try {
    await waiterOf(world.s.db, held);
    await protection(true);
  } finally {
    await held.letGo();
  }
  const answer = await topping;
  expect(codeOf(answer), 'protection switched on during the wait').toBe('STEP_UP_REQUIRED');
  expect(await world.maximumOf(taskId), 'the refusal raised nothing').toBe(MAXIMUM);
  const registered = await world.s.db.admin.execute(
    'select 1 from public.operations where business_id = $1 and operation_id = $2',
    [world.s.business, body.operationId],
  );
  expect(registered, 'the refusal holds no operation id').toEqual([]);

  // The same attempt once stepped up: applied once, then answered as itself.
  const fresh = world.s.decider.presented;
  const retried = await executeCommand(world.s.db.app, world.s.business, fresh, 'api', body);
  expect(codeOf(retried)).toBe('applied');
  const again = await executeCommand(world.s.db.app, world.s.business, fresh, 'api', body);
  expect(codeOf(again)).toBe('applied');
  expect(await world.maximumOf(taskId), 'one durable top-up').toBe(MAXIMUM + SMALL);
}, 60_000);

it('a top-up whose second factor ages out while it waits on the cap is judged on the clock read after the wait', async () => {
  await protection(true);
  const now = await databaseNow();
  // Inside the window for three seconds from now, stale from the fourth.
  const at = now - STEP_UP_WINDOW_SECONDS + 3;
  const deadline = await instantOf(world.s.db, 'select to_timestamp($1::float8)::text as at', [
    at + STEP_UP_WINDOW_SECONDS + 1,
  ]);
  const { taskId, held, topping } = await parkedTopUp(factorAt(at, now));
  let startedFresh = false;
  try {
    startedFresh = await blockedBefore(world.s.db, held, deadline);
    await waitPast(world.s.db, deadline);
  } finally {
    await held.letGo();
  }
  const answer = await topping;
  expect({
    startedFresh,
    code: codeOf(answer),
    maximum: await world.maximumOf(taskId),
  }).toEqual({ startedFresh: true, code: 'STEP_UP_REQUIRED', maximum: MAXIMUM });
}, 60_000);
