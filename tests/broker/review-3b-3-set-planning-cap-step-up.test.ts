// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-BATCH-2 #313, batch 3b, finding 3 (weak test): `budget.set_planning_cap`
// holds a money key (`billing:decide`), so C59's step-up applies to it, but
// nothing proves it. The S0-5 sweep's hand-kept SWEPT list
// (tests/operations/s0-5-step-up-sweep.test.ts) does not name it, and
// tests/broker/aw-04-set-planning-cap.test.ts claims a stale sign-in case in
// its header with no case behind it.
//
// The case: the business's billing holder, signed in with a second factor
// past C59's sixty minutes and then with no second factor at all, is refused
// STEP_UP_REQUIRED, and the business's budget_caps rows stay as they were.
// The same body on a fresh sign-in then applies, so the refusal is the
// step-up's and not the body's.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { Assurance } from '../../packages/core-records/src/identity/verified-subject.ts';
import { grantTo } from '../commands/fixture.ts';
import { noDatabase, s } from './broker-world.ts';
import { usePlanningWorld } from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

/** C59's sixty minutes, written here rather than read, so a widened window fails. */
const OWNER_WINDOW_SECONDS = 60 * 60;

usePlanningWorld('rv3b3');
// The decider holds `billing:decide` on the whole business: its owner.
beforeAll(async () => {
  if (noDatabase) return;
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'decide', undefined, false, 'billing');
  });
});

const setBody = (limitMinor: number, fromLimitMinor: number): Record<string, unknown> => ({
  command: 'budget.set_planning_cap',
  operationId: randomUUID(),
  limitMinor,
  currency: 'AUD',
  fromLimitMinor,
});

/** Every budget cap row of the business, whole, as the owner reads it. */
async function capRows(): Promise<readonly Record<string, unknown>[]> {
  return await s.db.admin.execute(
    `select id, key, limit_minor::text as limit_minor, currency from public.budget_caps
      where business_id = $1 order by key, id`,
    [s.business],
  );
}

async function dbNow(): Promise<number> {
  const [row] = await s.db.admin.execute<{ now: number }>(
    'select floor(extract(epoch from now()))::float8 as now',
  );
  return Number(row?.now);
}

const as = async (assurance: Assurance, body: Record<string, unknown>) =>
  await executeCommand(
    s.db.app,
    s.business,
    { ...s.decider.presented, assurance },
    'api',
    body as never,
  );

it('REVIEW-3B-3: budget.set_planning_cap refuses a stale second factor and a factorless sign-in STEP_UP_REQUIRED and leaves budget_caps unchanged; a fresh one applies', async () => {
  const now = await dbNow();
  const past = now - OWNER_WINDOW_SECONDS - 60;
  const stale: Readonly<Record<string, Assurance>> = {
    'factor past the window': { level: 'aal2', signedInAt: past, factorAt: past },
    'no second factor': { level: 'aal1', signedInAt: now, factorAt: null },
  };
  const before = await capRows();
  for (const [how, assurance] of Object.entries(stale)) {
    // eslint-disable-next-line no-await-in-loop
    const answer = await as(assurance, setBody(1_200, 5_000));
    expect(isCommandRefusal(answer) ? answer.code : 'applied', how).toBe('STEP_UP_REQUIRED');
    // eslint-disable-next-line no-await-in-loop
    expect(await capRows(), `${how}: budget_caps moved`).toStrictEqual(before);
  }
  // Control: the same body on a fresh sign-in applies and writes the cap.
  const fresh = await as({ level: 'aal2', signedInAt: now, factorAt: now }, setBody(1_200, 5_000));
  expect(isCommandRefusal(fresh) ? fresh.code : 'applied').toBe('applied');
  expect((await capRows()).find((row) => row['key'] === 'planning')).toMatchObject({
    limit_minor: '1200',
  });
});
