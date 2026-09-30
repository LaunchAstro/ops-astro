// SPDX-License-Identifier: AGPL-3.0-only
//
// C33: the run ceiling and the bounded event intake, against a real database
// (U36, #483 point 4). Both reuse AW-01's durable limit: each count is read
// back from the records under the business's lock, so a restarted worker
// meets the same count, and each lock names its business, so one business at
// its ceiling or bound never delays another. A run over the ceiling waits:
// dispatch writes nothing, and the occurrence stays approved with no
// dispatch, listed as waiting, until a run finishes. The hourly rates are in
// `c33-limits.test.ts`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimOccurrence,
  connect,
  dispatchOccurrence,
  FIRING_LIMITS,
  waitingOccurrences,
  type Dispatch,
} from '../../packages/core-records/src/index.ts';
import { awaitWaiters, barrier } from '../runtime/gate-negatives-cases.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  bravoApproved,
  firingOf,
  occurrenceOf,
  starter,
  type Approved,
  type Firing,
  type Starter,
} from './firing.ts';
import { createAutomationWorld, type AutomationWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C33 run ceiling and event intake', () => {
  let w: AutomationWorld;
  let f: Firing;
  let s: Starter;

  beforeAll(async () => {
    w = await createAutomationWorld('c33q');
    f = firingOf(w);
    s = starter(w.worker);
  });

  afterAll(async () => {
    await w?.db.drop();
  });

  /** Every occurrence run in the first business finishes (the agent engine's step). */
  const finishAll = async (): Promise<void> => {
    await w.db.admin.execute(
      `update public.planned_runs set state = 'handed_back'
        where business_id = $1 and origin_occurrence_id is not null`,
      [w.alpha],
    );
  };

  /** `n` approved occurrences of a scheduled activation, oldest first. */
  const approvedOccurrences = async (activationId: string, n: number): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      // oxlint-disable-next-line no-await-in-loop
      const occurrence = occurrenceOf(await w.claim(activationId, { dueAt: f.nextDue() }));
      expect(occurrence.outcome).toBe('approved');
      ids.push(occurrence.id);
    }
    return ids;
  };

  /** Dispatches each in turn with the world's worker; the answers' kinds. */
  const dispatchEach = async (ids: readonly string[]): Promise<Dispatch['kind'][]> => {
    const kinds: Dispatch['kind'][] = [];
    for (const id of ids) {
      // oxlint-disable-next-line no-await-in-loop
      kinds.push((await f.dispatch(id, s.start)).kind);
    }
    return kinds;
  };

  const waitingIn = async (business: string): Promise<string[]> =>
    (await w.db.app.withBusiness(business, (tx) => waitingOccurrences(tx))).map((o) => o.id);

  const queuedEvents = async (): Promise<number> =>
    await w.count(
      `select count(*) as n from public.activation_occurrences o
        where o.business_id = $1 and o.event_id is not null and o.outcome = 'approved'
          and not exists (select 1 from public.occurrence_dispatches d
                           where d.business_id = o.business_id and d.occurrence_id = o.id)`,
      [w.alpha],
    );

  /**
   * Fills the first business's event queue to `n`: approved events with no
   * dispatch, recorded two hours ago so the hourly rates have room.
   */
  const queueTo = async (n: number, approved: Approved): Promise<void> => {
    await w.db.admin.execute(
      `insert into public.activation_occurrences
         (business_id, id, activation_id, version_id, event_id, outcome, approval_id, recorded_at)
       select $1, gen_random_uuid(), $2, $3, 'seeded-' || gen_random_uuid(), 'approved', $4,
              now() - interval '2 hours'
         from generate_series(1, $5::int)`,
      [
        w.alpha,
        approved.activation.id,
        approved.version.id,
        approved.approval.id,
        n - (await queuedEvents()),
      ],
    );
    expect(await queuedEvents()).toBe(n);
  };

  it('C33 run ceiling waits: the 5th activation run in flight starts, the 6th waits shown as waiting and writes nothing, the count survives a restart, and the 6th starts when a run finishes', async () => {
    const { activation } = await f.approved();
    const ids = await approvedOccurrences(activation.id, FIRING_LIMITS.runsInFlight + 1);
    const sixth = ids[FIRING_LIMITS.runsInFlight]!;
    expect(await dispatchEach(ids.slice(0, FIRING_LIMITS.runsInFlight))).toEqual(
      Array.from({ length: FIRING_LIMITS.runsInFlight }, () => 'dispatched'),
    );

    expect(await f.dispatch(sixth, s.start)).toEqual({ kind: 'waiting' });
    expect(s.runs).toHaveLength(FIRING_LIMITS.runsInFlight);
    expect(
      await w.count(
        'select count(*) as n from public.occurrence_dispatches where occurrence_id = $1',
        [sixth],
      ),
    ).toBe(0);
    expect(await waitingIn(w.alpha)).toEqual([sixth]);

    // A restarted worker: a new pool, nothing carried over in memory.
    const restarted = connect(w.db.appUrl, { source: 'runtime' });
    try {
      const again = await restarted.withBusiness(w.alpha, (tx) =>
        dispatchOccurrence(tx, sixth, s.start),
      );
      expect(again).toEqual({ kind: 'waiting' });
    } finally {
      await restarted.close();
    }

    await w.db.admin.execute(
      `update public.planned_runs set state = 'handed_back'
        where id = (select run_id from public.occurrence_dispatches where occurrence_id = $1)`,
      [ids[0]],
    );
    expect(await f.dispatch(sixth, s.start)).toMatchObject({
      kind: 'dispatched',
      dispatch: { outcome: 'started' },
    });
    expect(await waitingIn(w.alpha)).toEqual([]);
  }, 120_000);

  it('C33 run ceiling waits: two dispatches racing for the last slot, the second waits for the first and is told to wait', async () => {
    await finishAll();
    const { activation } = await f.approved();
    const { activation: other } = await f.approved();
    const full = await approvedOccurrences(activation.id, FIRING_LIMITS.runsInFlight - 1);
    expect(new Set(await dispatchEach(full))).toEqual(new Set(['dispatched']));
    const [last] = await approvedOccurrences(activation.id, 1);
    const [rival] = await approvedOccurrences(other.id, 1);
    const held = barrier();
    const firstIn = barrier();
    const pool = connect(w.db.appUrl, { source: 'runtime' });
    try {
      // The first dispatch takes the last slot and holds its transaction open.
      const first = w.inAlpha(async (tx) => {
        const answer = await dispatchOccurrence(tx, last!, s.start);
        firstIn.release();
        await held.held;
        return answer.kind;
      });
      await firstIn.held;
      const second = pool.withBusiness(
        w.alpha,
        async (tx) => (await dispatchOccurrence(tx, rival!, s.start)).kind,
      );
      // Parked on the ceiling's lock (another activation, so not the activation's).
      await awaitWaiters(w.db, 1);
      held.release();
      expect([await first, await second]).toEqual(['dispatched', 'waiting']);
    } finally {
      held.release();
      await pool.close();
    }
  }, 120_000);

  it('C33 event intake bounded: the 1,000th event is queued, the 1,001st refused at intake and recorded, the bound survives a restart, and intake resumes once the queue drains', async () => {
    await finishAll();
    const approved = await f.approved('event');
    const id = approved.activation.id;
    await queueTo(FIRING_LIMITS.eventQueue - 1, approved);

    const last = occurrenceOf(await w.claim(id, { eventId: 'evt-1000' }));
    expect(last.outcome).toBe('approved');
    const refused = await w.claim(id, { eventId: 'evt-1001' });
    expect(refused).toMatchObject({
      kind: 'claimed',
      occurrence: { outcome: 'over_intake_bound', runId: null, eventId: 'evt-1001' },
    });
    expect(await queuedEvents()).toBe(FIRING_LIMITS.eventQueue);
    // Recorded, never dropped unseen: a replay of that event meets the refusal.
    expect(await w.claim(id, { eventId: 'evt-1001' })).toMatchObject({
      kind: 'replayed',
      occurrence: { outcome: 'over_intake_bound' },
    });

    const restarted = connect(w.db.appUrl, { source: 'runtime' });
    try {
      const again = await restarted.withBusiness(w.alpha, (tx) =>
        claimOccurrence(tx, id, { eventId: 'evt-1002' }),
      );
      expect(occurrenceOf(again).outcome).toBe('over_intake_bound');
    } finally {
      await restarted.close();
    }

    // The worker drains one: its run starts, and the queue has room again.
    expect(await f.dispatch(last.id, s.start)).toMatchObject({ kind: 'dispatched' });
    expect(occurrenceOf(await w.claim(id, { eventId: 'evt-1003' })).outcome).toBe('approved');
    expect(occurrenceOf(await w.claim(id, { eventId: 'evt-1004' })).outcome).toBe(
      'over_intake_bound',
    );
  }, 120_000);

  it('C33 limits fair across businesses: one business at its run ceiling and intake bound, with both locks held, never delays another business, whose event is queued and whose run starts', async () => {
    await finishAll();
    const { activation } = await f.approved();
    const { activation: other } = await f.approved();
    const events = await f.approved('event');
    const busy = await approvedOccurrences(activation.id, FIRING_LIMITS.runsInFlight + 1);
    await dispatchEach(busy.slice(0, FIRING_LIMITS.runsInFlight));
    const [rival] = await approvedOccurrences(other.id, 1);
    await queueTo(FIRING_LIMITS.eventQueue, events);
    const bravo = await bravoApproved(w, 'event');
    const bravoStarter = starter(w.bravoWorker);

    const held = barrier();
    const firstIn = barrier();
    const alphaAgain = connect(w.db.appUrl, { source: 'runtime' });
    const bravoWorker = connect(w.db.appUrl, { source: 'runtime' });
    try {
      // An alpha worker, refused at intake and told to wait, holds both locks open.
      const first = w.inAlpha(async (tx) => {
        const claim = await claimOccurrence(tx, events.activation.id, { eventId: 'evt-busy' });
        const dispatch = await dispatchOccurrence(tx, busy[FIRING_LIMITS.runsInFlight]!, s.start);
        firstIn.release();
        await held.held;
        return [occurrenceOf(claim).outcome, dispatch.kind];
      });
      await firstIn.held;
      // The lock is real: another alpha activation's dispatch waits on it.
      const second = alphaAgain.withBusiness(
        w.alpha,
        async (tx) => (await dispatchOccurrence(tx, rival!, s.start)).kind,
      );
      await awaitWaiters(w.db, 1);

      // Bravo answers while alpha's locks are held; alpha's counts are not its own.
      const parked = new Promise<'parked'>((resolve) => {
        setTimeout(() => resolve('parked'), 10_000).unref();
      });
      const bravoFires = async (): Promise<readonly string[]> => {
        const claim = occurrenceOf(
          await bravoWorker.withBusiness(w.bravo, (tx) =>
            claimOccurrence(tx, bravo, { eventId: 'evt-bravo' }),
          ),
        );
        const dispatch = await bravoWorker.withBusiness(w.bravo, (tx) =>
          dispatchOccurrence(tx, claim.id, bravoStarter.start),
        );
        return [claim.outcome, dispatch.kind];
      };
      expect(await Promise.race([bravoFires(), parked])).toEqual(['approved', 'dispatched']);
      expect(bravoStarter.runs).toHaveLength(1);
      expect(await waitingIn(w.bravo)).toEqual([]);

      held.release();
      expect(await first).toEqual(['over_intake_bound', 'waiting']);
      expect(await second).toBe('waiting');
    } finally {
      held.release();
      await alphaAgain.close();
      await bravoWorker.close();
    }
  }, 300_000);
});
