// SPDX-License-Identifier: AGPL-3.0-only
//
// SL11-30 GIVEBACK (FIXMONEY's left): a call counted at its maximum gives the
// envelope back what it did not spend when it ends lower, once, wherever its
// hold went in the meantime:
// - a budget top-up moved it to the envelope's actual and the hold was
//   replaced before the call settled;
// - the run stopped at its budget and a person ended it before the call settled;
// - the call was held as an unknown liability and a person, or the provider's
//   proof, resolved it below its maximum.
// A call ending at its maximum gives nothing back, and a give-back reaches only
// the call's own business's envelope. Through the real broker, custody,
// top-up, end, pickup, recorded outcome and pass.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import {
  endAtBudgetStop,
  sweepLostWorkers,
  topUpAtBudgetStop,
} from '../../packages/core-runtime/src/index.ts';
import type { Broker, ModelCallResult } from '../../packages/core-custody/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  appliedDetail,
  asAgent,
  codeOf,
  liveWork,
  rows,
  type Schedules,
  type Work,
} from '../runtime/schedules-harness.ts';
import { openSecond } from '../runtime/t3b-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import { callIn, faultBroker, outcome, pass } from './aw-10-world.ts';
import { broker, noDatabase, s, useBrokerWorld, world } from './broker-world.ts';
import {
  calls,
  decider,
  dispatched,
  envelopeActual,
  gated,
  reservationOf,
  runOf,
} from './give-back-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('givebacklate');

let other: Schedules;

/** Budget and gate permission for the decider (`billing:decide`, `gate:decide`). */
const openMoney = async (on: Schedules): Promise<void> => {
  await openBilling(on);
  await on.db.app.withBusiness(on.business, async (tx) => {
    await grantTo(tx, on.decider, 'decide', undefined, false, 'gate');
  });
};

beforeAll(async () => {
  if (noDatabase) return;
  await openMoney(s);
  other = await openSecond(s, 'giveback-away');
  await openMoney(other);
}, 120_000);

const topUp = async (on: Schedules, work: Work) =>
  await on.db.app.withBusiness(
    on.business,
    async (tx) =>
      await topUpAtBudgetStop(tx, {
        ...decider(on, await runOf(work)),
        amountMinor: 1_000,
        currency: 'AUD',
      }),
  );

const end = async (on: Schedules, work: Work) =>
  await on.db.app.withBusiness(
    on.business,
    async (tx) => await endAtBudgetStop(tx, decider(on, await runOf(work))),
  );

const sweep = async (on: Schedules = s): Promise<void> => {
  await on.db.app.withBusiness(on.business, async (tx) => await sweepLostWorkers(tx));
};

/** The pickup that classifies the stopped hold, whatever it answers. */
const pickupOf = async (work: Work) =>
  await asAgent(s, {
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId: reservationOf(work),
    leaseSeconds: 600,
  });

interface Stopped {
  readonly work: Work;
  /** The envelope's actual before the open call was counted. */
  readonly before: number;
  readonly open: () => void;
  readonly pending: Promise<ModelCallResult>;
}

/** 900 holds one call open at the replay maximum of 500, and the next stops the run. */
async function stoppedOpen(on: Schedules, base: Broker = broker): Promise<Stopped> {
  const work = await liveWork(on, `giveback late ${randomUUID()}`, 900);
  world.provider.mode('answer');
  const { broker: slow, open } = gated(base);
  const pending = callIn(on, work, slow);
  await dispatched(work);
  const before = await envelopeActual(work);
  expect(await callIn(on, work, base)).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE' });
  return { work, before, open, pending };
}

/** What the open call came to once it settled. */
const settled = async ({ work, open, pending }: Stopped): Promise<number> => {
  open();
  await pending;
  const [ended] = await calls(work);
  expect(ended?.state).not.toBe('dispatched');
  return Number(ended?.came_to);
};

it('an open call settling lower after a top-up gives the difference back once', async () => {
  const stopped = await stoppedOpen(s);
  const { work, before } = stopped;
  expect(await topUp(s, work)).toMatchObject({ ok: true, value: { state: 'applied' } });
  expect(codeOf(await pickupOf(work))).toBe('applied');
  expect(await envelopeActual(work), 'counted at its maximum').toBe(before + 500);

  const came = await settled(stopped);

  expect(came).toBeLessThan(500);
  expect(await envelopeActual(work)).toBe(before + came);
  await sweep();
  expect(await envelopeActual(work), 'given back once').toBe(before + came);
});

it('an open call settling lower after the run stopped at its budget gives the difference back once', async () => {
  const stopped = await stoppedOpen(s);
  const { work, before } = stopped;
  expect(await end(s, work)).toMatchObject({ ok: true, value: { spentMinor: 500 } });
  expect(await envelopeActual(work), 'counted at its maximum').toBe(before + 500);

  const came = await settled(stopped);

  expect(came).toBeLessThan(500);
  expect(await envelopeActual(work)).toBe(before + came);
  await sweep();
  expect(await envelopeActual(work), 'given back once').toBe(before + came);
});

/**
 * A call answered above its hold is held as an unknown liability at its
 * maximum, and the run calls on to its ceiling; the top-up moves that maximum
 * to the envelope's actual, and the pass holds the step unknown for a person.
 */
async function heldThenToppedUp(): Promise<{ readonly work: Work; readonly before: number }> {
  const work = await liveWork(s, `giveback held ${randomUUID()}`, 900);
  const before = await envelopeActual(work);
  world.provider.mode('costly');
  expect(await callIn(s, work, broker)).toMatchObject({ ok: false, code: 'LIABILITY_UNKNOWN' });
  world.provider.mode('answer');
  expect(await callIn(s, work, broker)).toMatchObject({ code: 'BUDGET_UNAVAILABLE' });
  expect(await topUp(s, work)).toMatchObject({ ok: true, value: { state: 'applied' } });
  await pass();
  expect(await envelopeActual(work), 'counted at its maximum').toBe(before + 500);
  return { work, before };
}

it("a person's liability_unknown resolution below the maximum gives the difference back once", async () => {
  const { work, before } = await heldThenToppedUp();

  appliedDetail(await outcome(s, work, 'nothing_happened'), 'budget.record_outcome');

  expect(await calls(work)).toMatchObject([{ state: 'released' }]);
  expect(await envelopeActual(work)).toBe(before);
  await sweep();
  expect(await envelopeActual(work), 'given back once').toBe(before);
});

it('a call settling at its maximum gives nothing back', async () => {
  const { work, before } = await heldThenToppedUp();
  const [hold] = await rows<{ held: string }>(
    s,
    'select held_minor::text as held from public.reservations where id = $1',
    [reservationOf(work)],
  );

  appliedDetail(await outcome(s, work, 'happened'), 'budget.record_outcome');

  expect(await calls(work)).toMatchObject([{ state: 'settled', came_to: '500' }]);
  // The step's hold settles whole, and the call stays counted at its maximum.
  expect(await envelopeActual(work)).toBe(before + 500 + Number(hold?.held));
});

it("a provider's proof that nothing happened gives the difference back once", async () => {
  const stopped = await stoppedOpen(s, faultBroker());
  const { work, before } = stopped;
  expect(await topUp(s, work)).toMatchObject({ ok: true, value: { state: 'applied' } });
  world.provider.mode('cut');
  world.provider.lookupMode('honest');
  expect(await settled(stopped)).toBe(0);
  expect(await calls(work)).toMatchObject([{ state: 'liability_unknown' }]);
  expect(await envelopeActual(work), 'counted at its maximum').toBe(before + 500);

  await pass();

  expect(await calls(work)).toMatchObject([{ state: 'released' }]);
  expect(await envelopeActual(work)).toBe(before);
  await pass();
  expect(await envelopeActual(work), 'given back once').toBe(before);
});

it("a give-back lands only in the call's own business envelope", async () => {
  const mine = await stoppedOpen(s);
  const theirs = await stoppedOpen(other);
  expect(await end(s, mine.work)).toMatchObject({ ok: true });
  expect(await end(other, theirs.work)).toMatchObject({ ok: true });

  const came = await settled(mine);

  expect(await envelopeActual(mine.work)).toBe(mine.before + came);
  expect(await envelopeActual(theirs.work), 'the other business moved nothing').toBe(
    theirs.before + 500,
  );
  const cameThere = await settled(theirs);
  expect(await envelopeActual(theirs.work)).toBe(theirs.before + cameThere);
  expect(await envelopeActual(mine.work), 'and its give-back moved nothing here').toBe(
    mine.before + came,
  );
});
