// SPDX-License-Identifier: AGPL-3.0-only
//
// C33: the occurrence rates, against a real database (U36, #483 point 4). The
// rates reuse AW-01's durable limit: each count is read back from the
// occurrence records under the business's lock, so a restarted scheduler meets
// the same count, and each lock names its business, so one business at its
// rate never delays another. The run ceiling and the event intake bound are
// in `c33-intake.test.ts`.

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
import { createAutomationWorld, type AutomationWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C33 limits on firing', () => {
  let w: AutomationWorld;
  let f: Firing;

  beforeAll(async () => {
    w = await createAutomationWorld('c33l');
    f = firingOf(w);
  });

  afterAll(async () => {
    await w?.db.drop();
  });

  const claimNext = async (activationId: string): Promise<OccurrenceOutcome> =>
    occurrenceOf(await w.claim(activationId, { dueAt: f.nextDue() })).outcome;

  /** Claims `n` due times in turn; the distinct outcomes. */
  const claimMany = async (activationId: string, n: number): Promise<OccurrenceOutcome[]> => {
    const outcomes = new Set<OccurrenceOutcome>();
    for (let i = 0; i < n; i += 1) {
      // One claim at a time: each reads the count the last one left.
      // oxlint-disable-next-line no-await-in-loop
      outcomes.add(await claimNext(activationId));
    }
    return [...outcomes];
  };

  /** Fills the first business's hour: its own activations, each at its own rate. */
  const fillBusinessHour = async (): Promise<void> => {
    const busy = FIRING_LIMITS.businessPerHour / FIRING_LIMITS.activationPerHour;
    for (let i = 0; i < busy; i += 1) {
      // oxlint-disable-next-line no-await-in-loop
      const { activation } = await f.approved();
      // oxlint-disable-next-line no-await-in-loop
      expect(await claimMany(activation.id, FIRING_LIMITS.activationPerHour)).toEqual(['approved']);
    }
  };

  /** The rolling hour moves on past every occurrence recorded so far. */
  const hourPasses = async (): Promise<void> => {
    await w.db.admin.execute(
      `update public.activation_occurrences set recorded_at = recorded_at - interval '61 minutes'`,
    );
  };

  it('C33 occurrence rate refused: the 60th occurrence in an hour per activation starts and the 61st is refused and recorded, the next window fires, and the count survives a scheduler restart', async () => {
    const { activation } = await f.approved();
    expect(await claimMany(activation.id, FIRING_LIMITS.activationPerHour)).toEqual(['approved']);
    const over = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    expect(over).toMatchObject({ outcome: 'over_activation_rate', runId: null });
    expect(await w.occurrences(activation.id)).toBe(FIRING_LIMITS.activationPerHour + 1);

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

    await hourPasses();
    expect(await claimNext(activation.id)).toBe('approved');
  }, 120_000);

  it('C33 occurrence rate refused: two claimers racing for the last place in the hour, the second waits for the first and is refused', async () => {
    await hourPasses();
    const { activation } = await f.approved();
    expect(await claimMany(activation.id, FIRING_LIMITS.activationPerHour - 1)).toEqual([
      'approved',
    ]);
    const held = barrier();
    const firstIn = barrier();
    const other = connect(w.db.appUrl, { source: 'runtime' });
    try {
      // The first claimer holds its transaction open after its claim.
      const first = w.inAlpha(async (tx) => {
        const claim = await claimOccurrence(tx, activation.id, { dueAt: f.nextDue() });
        firstIn.release();
        await held.held;
        return occurrenceOf(claim).outcome;
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
  }, 120_000);

  it('C33 occurrence rate refused: 600 per business, the 601st refused on an activation with room of its own, and the next window fires', async () => {
    await hourPasses();
    await fillBusinessHour();
    const { activation: quiet } = await f.approved();
    const over = occurrenceOf(await w.claim(quiet.id, { dueAt: f.nextDue() }));
    expect(over).toMatchObject({ outcome: 'over_business_rate', runId: null });
    expect(await w.occurrences(quiet.id)).toBe(1);

    await hourPasses();
    expect(await claimNext(quiet.id)).toBe('approved');
  }, 300_000);

  it('C33 limits fair across businesses: one business at its hourly rate, with a claimer holding its lock, never delays another business, whose occurrence is approved', async () => {
    await hourPasses();
    await fillBusinessHour();
    const bravo = await bravoApproved(w, 'scheduled');
    const { activation: quiet } = await f.approved();
    const { activation: another } = await f.approved();
    const held = barrier();
    const firstIn = barrier();
    const alphaAgain = connect(w.db.appUrl, { source: 'runtime' });
    const bravoScheduler = connect(w.db.appUrl, { source: 'runtime' });
    const claimIn = (business: string, pool: typeof alphaAgain, activationId: string) =>
      pool.withBusiness(
        business,
        async (tx) =>
          occurrenceOf(await claimOccurrence(tx, activationId, { dueAt: f.nextDue() })).outcome,
      );
    try {
      // An alpha claimer, over alpha's business rate, holds alpha's lock open.
      const first = w.inAlpha(async (tx) => {
        const claim = await claimOccurrence(tx, quiet.id, { dueAt: f.nextDue() });
        firstIn.release();
        await held.held;
        return occurrenceOf(claim).outcome;
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
      expect(await Promise.race([bravoClaim, parked])).toBe('approved');
      held.release();
      expect([await first, await second]).toEqual(['over_business_rate', 'over_business_rate']);
    } finally {
      held.release();
      await alphaAgain.close();
      await bravoScheduler.close();
    }
  }, 300_000);
});
