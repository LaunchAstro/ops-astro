// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one world, the ceiling and intake cases and the race that shares them */
//
// C33: the run ceiling and the bounded event intake, against a real database
// (U36, #483 point 4). Both reuse AW-01's durable limit: each count is read
// back from the records under the business's lock, so a restarted worker
// meets the same count, and each lock names its business, so one business at
// its ceiling or bound never delays another. A run over the ceiling waits:
// dispatch writes nothing, and the occurrence stays approved with no
// dispatch, listed as waiting, until a run finishes. An event past the bound
// is refused at intake and recorded `over_intake_bound`, never dropped
// unseen. The hourly rates are in `c33-limits.test.ts`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimOccurrence,
  connect,
  dispatchOccurrence,
  FIRING_LIMITS,
  type Dispatch,
} from '../../packages/core-records/src/index.ts';
import { awaitWaiters, barrier } from '../runtime/gate-negatives-cases.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { bravoApproved, firingOf, occurrenceOf, type Firing } from './firing.ts';
import {
  finishRuns,
  prepareRuns,
  seedApproved,
  waitingIn,
  workerStarter,
  type WorkerStarter,
  type Workers,
} from './run-start.ts';
import { createAutomationWorld, type Approved, type AutomationWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C33 run ceiling and event intake', () => {
  let w: AutomationWorld;
  let f: Firing;
  let k: Workers;
  let s: WorkerStarter;

  beforeAll(async () => {
    w = await createAutomationWorld('c33q');
    f = firingOf(w);
    k = await prepareRuns(w);
    s = workerStarter(k.worker);
  });

  afterAll(async () => {
    await w?.db.drop();
  });

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

  const queuedEvents = async (): Promise<number> =>
    await w.count(
      `select count(*) as n from public.activation_occurrences o
        where o.business_id = $1 and o.event_id is not null and o.outcome = 'approved'
          and not exists (select 1 from public.occurrence_dispatches d
                           where d.business_id = o.business_id and d.occurrence_id = o.id)`,
      [w.alpha],
    );

  /** Fills the first business's event queue to `n`, recorded two hours ago so the rates have room. */
  const queueTo = async (n: number, approved: Approved): Promise<void> => {
    await seedApproved(w, approved, n - (await queuedEvents()), { events: true, ago: '2 hours' });
    expect(await queuedEvents()).toBe(n);
  };

  it('the 5th activation run in flight starts, the 6th waits shown as waiting and writes nothing, the count survives a restart, and the 6th starts when a run finishes', async () => {
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
    expect(await waitingIn(w.db.app, w.alpha)).toEqual([sixth]);

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
    expect(await waitingIn(w.db.app, w.alpha)).toEqual([]);
  }, 60_000);

  it('two dispatches racing on separate connections for the last run slot: the second waits for the first and is told to wait', async () => {
    await finishRuns(w, w.alpha);
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
        try {
          const answer = await dispatchOccurrence(tx, last!, s.start);
          firstIn.release();
          await held.held;
          return answer.kind;
        } finally {
          firstIn.release();
        }
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
  }, 60_000);

  it('the 1,000th queued event is approved, the 1,001st is refused at intake as over the intake bound and recorded, the bound survives a restart, and intake resumes once the queue drains', async () => {
    await finishRuns(w, w.alpha);
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
    expect(
      await w.count(
        `select count(*) as n from public.activation_occurrences
          where business_id = $1 and outcome = 'over_intake_bound'`,
        [w.alpha],
      ),
    ).toBe(1);

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
  }, 60_000);

  // eslint-disable-next-line max-lines-per-function -- one race: both locks held, bravo answered
  it('one business at its run ceiling and intake bound, with both locks held, never delays another business, whose event is queued and whose run starts, and alpha’s ids under bravo start nothing', async () => {
    await finishRuns(w, w.alpha);
    const { activation } = await f.approved();
    const { activation: other } = await f.approved();
    const events = await f.approved('event');
    await dispatchEach(await approvedOccurrences(activation.id, FIRING_LIMITS.runsInFlight));
    const [rival] = await approvedOccurrences(other.id, 1);
    await queueTo(FIRING_LIMITS.eventQueue, events);
    // One transaction locks one activation: the held dispatch is of the events' own queue.
    const [queued] = await w.db.admin.execute<{ readonly id: string }>(
      "select id from public.activation_occurrences where activation_id = $1 and outcome = 'approved'",
      [events.activation.id],
    );
    const { activationId: bravo } = await bravoApproved(w, 'event', 'Bravo digest');
    const bravoStarter = workerStarter(k.bravoWorker);
    const alphaRuns = await w.count(
      'select count(*) as n from public.planned_runs where business_id = $1',
      [w.alpha],
    );

    const held = barrier();
    const firstIn = barrier();
    const alphaAgain = connect(w.db.appUrl, { source: 'runtime' });
    const bravoWorker = connect(w.db.appUrl, { source: 'runtime' });
    try {
      // An alpha worker, refused at intake and told to wait, holds both locks open.
      const first = w.inAlpha(async (tx) => {
        try {
          const claim = await claimOccurrence(tx, events.activation.id, { eventId: 'evt-busy' });
          const dispatch = await dispatchOccurrence(tx, queued!.id, s.start);
          firstIn.release();
          await held.held;
          return [occurrenceOf(claim).outcome, dispatch.kind];
        } finally {
          firstIn.release();
        }
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
      // Alpha's waiting occurrence sent under bravo is unknown there and starts nothing.
      const crossed = await bravoWorker.withBusiness(w.bravo, (tx) =>
        dispatchOccurrence(tx, rival!, bravoStarter.start),
      );
      expect(crossed).toEqual({ kind: 'unknown' });
      expect(JSON.stringify(crossed)).not.toContain(w.canary);
      expect(bravoStarter.runs).toHaveLength(1);
      // On bravo's own pool: alpha's is the held transaction's.
      expect(await waitingIn(bravoWorker, w.bravo)).toEqual([]);

      held.release();
      expect(await first).toEqual(['over_intake_bound', 'waiting']);
      expect(await second).toBe('waiting');
      // Bravo's flood of one touched none of alpha's runs.
      expect(
        await w.count('select count(*) as n from public.planned_runs where business_id = $1', [
          w.alpha,
        ]),
      ).toBe(alphaRuns);
    } finally {
      held.release();
      await alphaAgain.close();
      await bravoWorker.close();
    }
  }, 60_000);
});
