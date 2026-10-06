// SPDX-License-Identifier: AGPL-3.0-only
//
// A call closes once (AW-01, AW-10): settled at its answer, released, or held
// as an unknown liability, whichever comes first. A call already closed, by
// the provider's proof or by its own answer, ignores any later close and gives
// nothing back again, so the envelope counts what the call came to, once.
// A call still unsent when its hold closes counts nothing, and its send is then
// refused, so no spend goes unaccounted (ORCH70-SPENDUNSENT). Through the real
// broker, custody, sweep, pass, top-up and pickup.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import { sweepLostWorkers, topUpAtBudgetStop } from '../../packages/core-runtime/src/index.ts';
import {
  reserveModelCall,
  sendReservedCall,
  type Broker,
  type ModelCallResult,
} from '../../packages/core-custody/src/index.ts';
import type { ReservedCall } from '../../packages/core-custody/src/broker-reserve.ts';
import { settle } from '../../packages/core-custody/src/broker-settle.ts';
import { writeAuditEvent } from '../../packages/core-commands/src/commands/audit.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  appliedDetail,
  liveWork,
  pickup,
  type Schedules,
  type Work,
} from '../runtime/schedules-harness.ts';
import { openSecond } from '../runtime/t3b-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import { holdsOn, revoke } from '../runtime/resume-sizing-world.ts';
import { callIn, faultBroker, outcome, pass } from './aw-10-world.ts';
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
import {
  calls,
  decider,
  dispatched,
  envelopeActual,
  gated,
  heldAtEnvelope,
  reservationOf,
  resumeOnceBlocked,
  runOf,
} from './give-back-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('closesonce');

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
  other = await openSecond(s, 'closesonce-away');
  await openMoney(other);
}, 120_000);

/** The decider tops up the work's stopped run: the spend to date moves to the envelope's actual. */
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

/** The work's step hold: what the envelope counts against its cap while it is held. */
const heldOn = async (work: Work): Promise<number> => {
  const [hold] = await s.db.admin.execute<{ held: string }>(
    'select held_minor::text as held from public.reservations where id = $1',
    [reservationOf(work)],
  );
  return Number(hold?.held);
};

/** What the envelope counts for the work's calls: each at what it came to. */
const cameTo = async (work: Work): Promise<number> =>
  (await calls(work)).reduce((sum, one) => sum + Number(one.came_to), 0);

it('a call whose request has not reached the provider is not closed by its lookup; its late answer settles it at its charge, counted once', async () => {
  const work = await liveWork(s, `closes once proved ${randomUUID()}`, 2_000);
  world.provider.mode('answer');
  world.provider.lookupMode('honest');
  const { broker: slow, open } = gated(faultBroker());
  const late = callIn(s, work, slow);
  await dispatched(work);
  const before = await envelopeActual(work);
  const held = await heldOn(work);
  // Its worker is lost: the sweep holds the call unknown while custody still waits on it.
  await s.db.admin.execute(
    `update public.leases set expires_at = clock_timestamp() - interval '1 second' where id = $1`,
    [work.picked['leaseId']],
  );
  await s.db.app.withBusiness(s.business, async (tx) => await sweepLostWorkers(tx));
  await pass();
  // The request may still reach the provider, so the lookup proves nothing and the call stays held.
  expect(await calls(work)).toMatchObject([{ state: 'liability_unknown', came_to: '0' }]);

  open();

  // The provider processed it and its answer closes the call at the provider's charge.
  // Its lost worker gets no text back; the money is on the call.
  expect(await late).toMatchObject({ ok: false });
  expect(world.provider.processed.size).toBeGreaterThan(0);
  const came = await cameTo(work);
  expect(came).toBeGreaterThan(0);
  const closedAt = [{ state: 'settled', came_to: String(came) }];
  expect(await calls(work)).toMatchObject(closedAt);
  expect(await calls(work)).toHaveLength(1);
  // The step's hold stays whole for a person, counting the charge against the cap; the
  // envelope's actual moves only when the hold ends. A second pass counts nothing again.
  for (let again = 0; again < 2; again += 1) {
    // eslint-disable-next-line no-await-in-loop
    expect(await envelopeActual(work)).toBe(before);
    // eslint-disable-next-line no-await-in-loop
    expect(await heldOn(work)).toBe(held);
    // eslint-disable-next-line no-await-in-loop
    await pass();
  }
  expect(await calls(work)).toMatchObject(closedAt);
  // A person says the step happened: its hold settles whole, the call's charge inside it, once.
  appliedDetail(await outcome(s, work, 'happened'), 'budget.record_outcome');
  expect(await envelopeActual(work)).toBe(before + held);
  await pass();
  expect(await envelopeActual(work), 'counted once').toBe(before + held);
  expect(await calls(work)).toMatchObject(closedAt);
});

// The late answer and the provider's proof race on a call a top-up counted at
// its maximum. A worker marks its step dispatched before it acts (written
// here after the top-up, which reads no mark), so once the sweep holds the
// call, a pass holds the step unknown too and asks the provider. Nothing happened: the provider proves the call absent while its
// late answer, a release, settles on a connection of its own. The pass waits
// on the envelope lock the answer holds, then finds no open call.
it("a counted unknown call's late answer racing the provider's proof gives back once", async () => {
  const work = await liveWork(s, `closes once raced ${randomUUID()}`, 900);
  world.provider.mode('nothing_happened');
  const held = heldAtEnvelope(s);
  const { broker: slow, open } = gated(faultBroker());
  const late = callIn(held.on, work, slow);
  try {
    await dispatched(work);
    const before = await envelopeActual(work);
    expect(await callIn(s, work, broker)).toMatchObject({ code: 'BUDGET_UNAVAILABLE' });
    expect(await topUp(s, work)).toMatchObject({ ok: true, value: { state: 'applied' } });
    await s.db.admin.execute(
      `update public.attempts set dispatch_marker = true where reservation_id = $1`,
      [reservationOf(work)],
    );
    world.provider.lookupMode('unreachable');
    await pass();
    expect(await calls(work)).toMatchObject([{ state: 'liability_unknown' }]);
    expect(await envelopeActual(work), 'counted at its maximum').toBe(before + 500);

    world.provider.lookupMode('honest');
    open();
    await held.reached;
    const contended = resumeOnceBlocked(s, held.resume);
    await Promise.all([late, pass()]);

    expect(await contended, "the provider's proof waited on the envelope lock").toBe(true);
    expect(await calls(work)).toMatchObject([{ state: 'released', came_to: '0' }]);
    expect(await envelopeActual(work), 'given back once').toBe(before);
  } finally {
    open();
    held.resume();
    await Promise.allSettled([late]);
    await held.close();
  }
});

it('a dispatched call settles once at its answer', async () => {
  const work = await liveWork(s, `closes once answered ${randomUUID()}`, 2_000);
  world.provider.mode('answer');

  const answered = await callIn(s, work, faultBroker());

  expect(answered).toMatchObject({ ok: true });
  const actual = answered.ok ? answered.actualMinor : -1;
  expect(actual).toBeGreaterThan(0);
  expect(await calls(work)).toMatchObject([{ state: 'settled', came_to: String(actual) }]);
});

interface Settled {
  readonly work: Work;
  /** The envelope's actual before the open call was counted. */
  readonly before: number;
  /** What the call came to. */
  readonly came: number;
  /** The same call settled again, released. */
  readonly release: () => Promise<ModelCallResult>;
}

/**
 * A call open when the next call stopped its run, counted at its maximum of
 * 500 by the top-up, then settled at its answer: it gives the rest back once.
 */
async function settledAfterTopUp(on: Schedules): Promise<Settled> {
  const work = await liveWork(on, `closes once settled ${randomUUID()}`, 900);
  world.provider.mode('answer');
  const { broker: slow, open } = gated(auditedIn(on, broker));
  const { reserved, sent } = await heldCall(on, work, slow);
  const pending = sent();
  await dispatched(work);
  const before = await envelopeActual(work);
  expect(await callIn(on, work, broker)).toMatchObject({ code: 'BUDGET_UNAVAILABLE' });
  expect(await topUp(on, work)).toMatchObject({ ok: true, value: { state: 'applied' } });
  expect(await envelopeActual(work), 'counted at its maximum').toBe(before + 500);
  open();
  await pending;
  const came = await cameTo(work);
  expect(came).toBeGreaterThan(0);
  expect(await envelopeActual(work), 'given back once').toBe(before + came);
  const release = async () =>
    await settle(
      on.db.app,
      on.business,
      callerIn(on, work),
      requestFor(work),
      reserved,
      { kind: 'nothing', reason: 'a later release' },
      auditedIn(on, broker),
    );
  return { work, before, came, release };
}

const callerIn = (on: Schedules, work: Work) => ({ ...caller(work), actorId: on.agentActorId });

/** `with_`, its events written as `on`'s own agent, as `callIn` writes them. */
const auditedIn = (on: Schedules, with_: Broker): Broker => ({
  ...with_,
  audit: async (tx, note) => {
    await writeAuditEvent(tx, {
      actorId: on.agentActorId,
      command: note.action,
      outcome: note.outcome,
      refusalCode: note.refusalCode,
      payloadDigest: digestOf(note.detail),
      attempted: note.outcome === 'refused' ? note.detail : null,
    });
  },
});

/** The work's one call, held, and sent through `slow` when asked. */
async function heldCall(
  on: Schedules,
  work: Work,
  slow: Broker,
): Promise<{ readonly reserved: ReservedCall; readonly sent: () => Promise<ModelCallResult> }> {
  await stepOf(work);
  const asked = callerIn(on, work);
  const held = await on.db.app.withBusiness(
    on.business,
    async (tx) => await reserveModelCall(tx, asked, requestFor(work), slow),
  );
  if (!held.ok) throw new Error(`the call was not held: ${held.code}`);
  const sent = async () =>
    await sendReservedCall(on.db.app, on.business, asked, requestFor(work), held.reserved, slow);
  return { reserved: held.reserved, sent };
}

it('a call settled by its answer ignores a later release: no second give-back', async () => {
  const { work, before, came, release } = await settledAfterTopUp(s);

  expect(await release()).toMatchObject({ ok: false });

  expect(await calls(work)).toMatchObject([{ state: 'settled', came_to: String(came) }]);
  expect(await envelopeActual(work), 'no second give-back').toBe(before + came);
});

// An unsent call costs nothing: the revoke releases its hold at 0, the send
// after that is refused and sends nothing, and the step's fresh hold is the
// whole of the old one.
it('a call unsent when its hold closed is refused at its send and counts nothing', async () => {
  const work = await liveWork(s, `closes once unsent ${randomUUID()}`, 2_000);
  const { sent } = await heldCall(s, work, broker);
  const before = await envelopeActual(work);
  await revoke(work);
  expect(await envelopeActual(work), 'an unsent call counts nothing').toBe(before);
  expect(await holdsOn(work)).toMatchObject([{ state: 'abandoned', held: '2000', actual: null }]);

  expect(await sent()).toMatchObject({ ok: false, code: 'LEASE_EXPIRED' });
  expect(await calls(work)).toMatchObject([{ state: 'released', came_to: '0' }]);
  expect(await envelopeActual(work), 'released unsent, nothing counted').toBe(before);

  await pickup(s, reservationOf(work));

  expect(await holdsOn(work)).toMatchObject([
    { state: 'abandoned', held: '2000', actual: null },
    { state: 'held', held: '2000' },
  ]);
});

it("a give-back lands only in the call's own business envelope", async () => {
  const mine = await settledAfterTopUp(s);
  const theirs = await settledAfterTopUp(other);
  expect(await envelopeActual(mine.work), 'the other business moved nothing here').toBe(
    mine.before + mine.came,
  );

  expect(await mine.release()).toMatchObject({ ok: false });
  expect(await theirs.release()).toMatchObject({ ok: false });

  expect(await envelopeActual(mine.work)).toBe(mine.before + mine.came);
  expect(await envelopeActual(theirs.work)).toBe(theirs.before + theirs.came);
});
