// SPDX-License-Identifier: AGPL-3.0-only
//
// C33: the occurrence rates, against a real database (U36, #483 point 4). The
// rates reuse AW-01's durable limit: each count is read back from the
// occurrence records under the business's lock, so a restarted scheduler meets
// the same count, and each lock names its business, so one business at its
// rate never delays another. An occurrence past a rate is recorded with the
// rate it is over and starts no run. The run ceiling and the event intake
// bound are in `c33-intake.test.ts`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimOccurrence,
  connect,
  FIRING_LIMITS,
  type OccurrenceOutcome,
} from '../../packages/core-records/src/index.ts';
import { awaitWaiters, barrier } from '../runtime/gate-negatives-cases.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { bravoApproved, firingOf, occurrenceOf, type Firing } from './firing.ts';
import { hourPasses, prepareRuns, seedApproved, workerStarter, type Workers } from './run-start.ts';
import { createAutomationWorld, type AutomationWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();
const NOW = { events: false, ago: '0 minutes' } as const;

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C33 limits on firing', () => {
  let w: AutomationWorld;
  let f: Firing;
  let k: Workers;

  beforeAll(async () => {
    w = await createAutomationWorld('c33l');
    f = firingOf(w);
    k = await prepareRuns(w);
  });

  afterAll(async () => {
    await w?.db.drop();
  });

  const claimNext = async (activationId: string): Promise<OccurrenceOutcome> =>
    occurrenceOf(await w.claim(activationId, { dueAt: f.nextDue() })).outcome;

  it('the 60th occurrence in an hour per activation is approved and starts its run, the 61st is refused as over the activation rate and recorded, the count survives a scheduler restart, and the next window fires', async () => {
    const approved = await f.approved();
    const { activation } = approved;
    await seedApproved(w, approved, FIRING_LIMITS.activationPerHour - 1, NOW);
    const sixtieth = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    expect(sixtieth.outcome).toBe('approved');
    const sent = await f.dispatch(sixtieth.id, workerStarter(k.worker).start);
    expect(sent.kind === 'dispatched' && sent.dispatch.outcome).toBe('started');

    const over = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    expect(over).toMatchObject({ outcome: 'over_activation_rate', runId: null });
    expect(await w.occurrences(activation.id)).toBe(FIRING_LIMITS.activationPerHour + 1);
    expect(
      await w.count(
        'select count(*) as n from public.planned_runs where origin_occurrence_id = $1',
        [over.id],
      ),
    ).toBe(0);

    // A restarted scheduler: a new pool, nothing carried over in memory.
    const restarted = connect(w.db.appUrl, { source: 'runtime' });
    try {
      const again = await restarted.withBusiness(w.alpha, (tx) =>
        claimOccurrence(tx, activation.id, { dueAt: f.nextDue() }),
      );
      expect(occurrenceOf(again).outcome).toBe('over_activation_rate');
    } finally {
      await restarted.close();
    }

    await hourPasses(w);
    expect(await claimNext(activation.id)).toBe('approved');
  }, 60_000);

  it('two claimers racing on separate connections for the last place in the hour: the second waits for the first and is refused as over the activation rate', async () => {
    await hourPasses(w);
    const approved = await f.approved();
    const { activation } = approved;
    await seedApproved(w, approved, FIRING_LIMITS.activationPerHour - 1, NOW);
    const held = barrier();
    const firstIn = barrier();
    const other = connect(w.db.appUrl, { source: 'runtime' });
    try {
      // The first claimer holds its transaction open after its claim.
      const first = w.inAlpha(async (tx) => {
        try {
          const claim = await claimOccurrence(tx, activation.id, { dueAt: f.nextDue() });
          firstIn.release();
          await held.held;
          return occurrenceOf(claim).outcome;
        } finally {
          firstIn.release();
        }
      });
      await firstIn.held;
      const second = other.withBusiness(
        w.alpha,
        async (tx) =>
          occurrenceOf(await claimOccurrence(tx, activation.id, { dueAt: f.nextDue() })).outcome,
      );
      // The second is parked on the first's lock, not answered.
      await awaitWaiters(w.db, 1);
      held.release();
      expect([await first, await second]).toEqual(['approved', 'over_activation_rate']);
    } finally {
      held.release();
      await other.close();
    }
  }, 60_000);

  it('a claimer that waited on the rate lock stamps its occurrence at or after its wait ended, so the row stays in the hour the count read', async () => {
    await hourPasses(w);
    const { activation } = await f.approved();
    const held = barrier();
    const firstIn = barrier();
    const other = connect(w.db.appUrl, { source: 'runtime' });
    try {
      const first = w.inAlpha(async (tx) => {
        try {
          await claimOccurrence(tx, activation.id, { dueAt: f.nextDue() });
          firstIn.release();
          await held.held;
        } finally {
          firstIn.release();
        }
      });
      await firstIn.held;
      const second = other.withBusiness(w.alpha, async (tx) =>
        occurrenceOf(await claimOccurrence(tx, activation.id, { dueAt: f.nextDue() })),
      );
      await awaitWaiters(w.db, 1);
      // The database's clock while the second is still parked on the lock.
      const [parked] = await w.db.admin.execute<{ readonly at: string }>(
        `select clock_timestamp()::text as at`,
      );
      held.release();
      await first;
      const { id } = await second;
      const [stamp] = await w.db.admin.execute<{ readonly after_wait: boolean }>(
        `select recorded_at >= $2::timestamptz as after_wait
           from public.activation_occurrences where id = $1`,
        [id, parked?.at],
      );
      expect(stamp).toStrictEqual({ after_wait: true });
    } finally {
      held.release();
      await other.close();
    }
  }, 60_000);

  it('the 601st occurrence in an hour per business is refused as over the business rate on an activation with room of its own, and the next window fires', async () => {
    await hourPasses(w);
    const busy = await f.approved();
    await seedApproved(w, busy, FIRING_LIMITS.businessPerHour, NOW);
    const { activation: quiet } = await f.approved();
    const over = occurrenceOf(await w.claim(quiet.id, { dueAt: f.nextDue() }));
    expect(over).toMatchObject({ outcome: 'over_business_rate', runId: null });
    expect(await w.occurrences(quiet.id)).toBe(1);

    await hourPasses(w);
    expect(await claimNext(quiet.id)).toBe('approved');
  }, 60_000);

  // eslint-disable-next-line max-lines-per-function -- one race: the lock held, bravo answered
  it('one business at its hourly rate, with a claimer holding its lock, never delays another business, whose occurrence is approved, and its refusal carries none of the other business’s names', async () => {
    await hourPasses(w);
    const busy = await f.approved();
    await seedApproved(w, busy, FIRING_LIMITS.businessPerHour, NOW);
    const { activationId: bravo } = await bravoApproved(w, 'scheduled', 'Bravo digest');
    const { activation: quiet } = await f.approved();
    const { activation: another } = await f.approved();
    const held = barrier();
    const firstIn = barrier();
    const alphaAgain = connect(w.db.appUrl, { source: 'runtime' });
    const bravoScheduler = connect(w.db.appUrl, { source: 'runtime' });
    const claimIn = async (business: string, pool: typeof alphaAgain, activationId: string) =>
      await pool.withBusiness(business, async (tx) =>
        occurrenceOf(await claimOccurrence(tx, activationId, { dueAt: f.nextDue() })),
      );
    try {
      // An alpha claimer, over alpha's business rate, holds alpha's lock open.
      const first = w.inAlpha(async (tx) => {
        try {
          const claim = await claimOccurrence(tx, quiet.id, { dueAt: f.nextDue() });
          firstIn.release();
          await held.held;
          return occurrenceOf(claim);
        } finally {
          firstIn.release();
        }
      });
      await firstIn.held;
      // The lock is real: another alpha activation waits on it.
      const second = claimIn(w.alpha, alphaAgain, another.id);
      await awaitWaiters(w.db, 1);
      // Bravo answers while alpha's lock is still held, and alpha's hour is not its count.
      const parked = new Promise<'parked'>((resolve) => {
        setTimeout(() => resolve('parked'), 10_000).unref();
      });
      const bravoClaim = claimIn(w.bravo, bravoScheduler, bravo);
      const answered = await Promise.race([bravoClaim, parked]);
      expect(answered !== 'parked' && answered.outcome).toBe('approved');
      expect(JSON.stringify(answered)).not.toContain(w.canary);
      held.release();
      const refused = [await first, await second];
      expect(refused.map((one) => one.outcome)).toEqual([
        'over_business_rate',
        'over_business_rate',
      ]);
      expect(JSON.stringify(refused)).not.toContain(w.canary);
    } finally {
      held.release();
      await alphaAgain.close();
      await bravoScheduler.close();
    }
  }, 60_000);
});
