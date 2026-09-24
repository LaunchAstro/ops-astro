// SPDX-License-Identifier: AGPL-3.0-only
//
// R1, the concurrency half: two classifiers, one reservation, one released hold.
//
// The reviewer's case was two classifiers both reading a reservation as `held`,
// both moving its attempt and both subtracting the same hold from one envelope
// — a double subtraction the non-negative constraint catches only when it
// drives the envelope's total below zero. So the fixture here deliberately
// leaves the constraint nothing to catch: the raced hold is one of **two**
// holds on the same envelope, so a second subtraction lands on a total that can
// absorb it and would be silent accounting corruption rather than a database
// error. What the case asserts is the accounting, not the error.
//
// **The interleaving is forced and observed, not slept through**, the way
// `gate.test.ts` forces its own. One backend classifies inside the complete
// ordered lock set and is held open on a barrier; the second backend is
// started only once the first has written, and it is *seen* parked on a row
// lock in `pg_stat_activity` — on `budget_caps`, the first class in
// `LOCK_ORDER`, which is the evidence that it parked at acquisition and before
// it read anything. A run that cannot establish that interleaving throws
// instead of passing quietly, and the barrier is released in `finally` with
// both transactions settled through `Promise.allSettled` before any assertion,
// so a failed synchronisation reports rather than hangs
// (`tests/identity/login-kind-race.test.ts`, finding 2).
//
// Both orderings are here, because the loser's answer is a different one in
// each. When the **restart replay** loses, it holds the complete set and
// re-reads the affected set under it, finds the reservation is no longer in it,
// and refuses before it writes. When a **direct classification** under the same
// locks loses, it reads the committed terminal row and reports it: released
// false, state abandoned, nothing written.
//
// What this does not prove: it does not reach `classifyUnderLocks`'s own
// `another transaction classified this reservation first` branch. While both
// racers hold the reservation lock the contract requires, the server serialises
// them before either can read a stale `held`, so that guarded update is
// defence in depth underneath the locks rather than the thing the locks leave
// to chance. Making it fire would mean a caller holding an incomplete set,
// which `LockSet.require` throws on — `review-fixes.test.ts` covers that.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { propose } from '../../packages/core-runtime/src/propose.ts';
import { decide } from '../../packages/core-runtime/src/decide.ts';
import { acquire } from '../../packages/core-runtime/src/locks.ts';
import {
  classifyUnderLocks,
  replayRecordedTransitions,
  type Classification,
} from '../../packages/core-runtime/src/recovery.ts';
import {
  buildFixture,
  envelopeTotals,
  newTask,
  subjectsOf,
  TASK_COLLECTION,
  TEST_SIGNING_KEY,
  type RuntimeFixture,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/classifier-race: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

/** The first approved version's ceiling becomes the envelope's, so it is the roomy one. */
const ENVELOPE_CEILING = 5_000;

/** The raced hold, and its sibling's. Two of them fit under the ceiling above. */
const HOLD = 1_000;

const hour = (): Date => new Date(Date.now() + 3_600_000);

/** A promise the test resolves by hand, which is how a transaction is held open. */
function barrier(): { readonly held: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Ask the server whether a backend is parked on a lock, rather than sleeping and hoping. */
async function awaitBlockedOnLock(database: FreshDatabase): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // Polling is sequential by definition: each question is about the state
    // the previous answer did not find.
    // eslint-disable-next-line no-await-in-loop
    const rows = await database.admin.execute<{ readonly waiting: string }>(
      `select count(*)::text as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (Number(rows[0]?.waiting ?? 0) > 0) return;
    // eslint-disable-next-line no-await-in-loop
    await delay(25);
  }
  throw new Error('no backend ever blocked on a lock: the interleaving was not established');
}

/**
 * Which table the parked backend wants. A waiter takes the tuple lock first and
 * then waits on the holder's transaction, so the tuple lock names the row it
 * asked for — which is how this case tells "parked at acquisition" from
 * "parked on its own write".
 */
async function blockedOnRelation(database: FreshDatabase): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await database.admin.execute<{ readonly relname: string }>(
      `select c.relname from pg_stat_activity a
         join pg_locks l on l.pid = a.pid and l.locktype = 'tuple'
         join pg_class c on c.oid = l.relation
        where a.datname = current_database() and a.wait_event_type = 'Lock'
        limit 1`,
    );
    const relname = rows[0]?.relname;
    if (relname !== undefined) return relname;
    // eslint-disable-next-line no-await-in-loop
    await delay(25);
  }
  throw new Error('no backend ever blocked on a row lock: the interleaving was not established');
}

interface Proposed {
  readonly lineageId: string;
  readonly versionId: string;
  readonly gateId: string;
  readonly runId: string;
}

async function proposeOn(
  database: FreshDatabase,
  fixture: RuntimeFixture,
  options: {
    readonly taskId: string;
    readonly lineageId?: string;
    readonly maximumMinor: number;
  },
): Promise<Proposed> {
  return await database.app.withBusiness(fixture.businessId, async (tx) => {
    const result = await propose(tx, {
      taskId: options.taskId,
      collection: TASK_COLLECTION,
      proposedByActorId: fixture.decider.actorId,
      subjects: subjectsOf(fixture.decider),
      purpose: 'draft_the_brief',
      maximumMinor: options.maximumMinor,
      currency: 'AUD',
      payload: { instruction: 'draft it' },
      step: { kind: 'local.draft', payload: { words: 200 } },
      expiresAt: hour(),
      ...(options.lineageId === undefined ? {} : { lineageId: options.lineageId }),
    });
    if (!result.ok)
      throw new Error(`propose refused ${result.refusal.code}: ${result.refusal.reason}`);
    return result.value;
  });
}

async function approveOn(
  database: FreshDatabase,
  fixture: RuntimeFixture,
  of: Proposed,
): Promise<{ readonly reservationId: string; readonly envelopeId: string }> {
  const decided = await database.app.withBusiness(fixture.businessId, async (tx) =>
    decide(tx, {
      gateId: of.gateId,
      versionId: of.versionId,
      decidedByPersonId: fixture.decider.personId,
      decidedByActorId: fixture.decider.actorId,
      subjects: subjectsOf(fixture.decider),
      collection: TASK_COLLECTION,
      decision: 'approve',
      note: 'go',
      signingKey: TEST_SIGNING_KEY,
      capId: fixture.capId,
    }),
  );
  if (!decided.ok)
    throw new Error(`decide refused ${decided.refusal.code}: ${decided.refusal.reason}`);
  if (decided.value.decision !== 'approve')
    throw new Error(`expected an approval, got ${decided.value.decision}`);
  return {
    reservationId: decided.value.reservationId as string,
    envelopeId: decided.value.envelopeId as string,
  };
}

/** Everything the two racers name, and the sibling hold that absorbs a wrong subtraction. */
interface RacedHold {
  readonly taskId: string;
  readonly envelopeId: string;
  readonly lineageId: string;
  readonly runId: string;
  readonly versionId: string;
  readonly reservationId: string;
  readonly attemptId: string;
  readonly siblingReservationId: string;
}

/**
 * One envelope, two held reservations, and a recorded transition over one of
 * them whose classification did not commit.
 *
 * The roomy first version sets the envelope's ceiling and is superseded
 * immediately, which releases its own hold through the real supersession path.
 * The raced hold and its sibling are then two ordinary approvals under that
 * ceiling. The transition the racers classify is written straight onto the
 * version row, because the product's own supersession classifies in the same
 * transaction (R8) and would leave nothing to race over; a committed
 * transition with no committed classification is exactly the crash state
 * recovery exists for, and `review-fixes.test.ts` stages a fenced lease the
 * same way.
 */
async function racedHold(database: FreshDatabase, fixture: RuntimeFixture): Promise<RacedHold> {
  const taskId = await newTask(database.app, fixture.businessId, fixture.decider);

  const roomy = await proposeOn(database, fixture, { taskId, maximumMinor: ENVELOPE_CEILING });
  const opened = await approveOn(database, fixture, roomy);

  const raced = await proposeOn(database, fixture, {
    taskId,
    lineageId: roomy.lineageId,
    maximumMinor: HOLD,
  });
  const held = await approveOn(database, fixture, raced);

  const sibling = await proposeOn(database, fixture, { taskId, maximumMinor: HOLD });
  const alongside = await approveOn(database, fixture, sibling);

  const attemptId = await database.app.withBusiness(fixture.businessId, async (tx) => {
    await tx.query(
      `update public.proposal_versions set superseded_at = now()
        where business_id = $1 and id = $2`,
      [fixture.businessId, raced.versionId],
    );
    const rows = await tx.query<{ readonly id: string }>(
      `select id from public.attempts where business_id = $1 and reservation_id = $2`,
      [fixture.businessId, held.reservationId],
    );
    return rows[0]?.id as string;
  });

  return {
    taskId,
    envelopeId: opened.envelopeId,
    lineageId: roomy.lineageId,
    runId: raced.runId,
    versionId: raced.versionId,
    reservationId: held.reservationId,
    attemptId,
    siblingReservationId: alongside.reservationId,
  };
}

/** The complete ordered set an owning operation holds to classify this one hold. */
function lockSetFor(fixture: RuntimeFixture, work: RacedHold) {
  return [
    { lockClass: 'cap' as const, id: fixture.capId },
    { lockClass: 'envelope' as const, id: work.envelopeId },
    { lockClass: 'task' as const, id: work.taskId },
    { lockClass: 'run' as const, id: work.runId },
    { lockClass: 'lineage' as const, id: work.lineageId },
    { lockClass: 'reservation' as const, id: work.reservationId },
  ];
}

interface TerminalRow {
  readonly state: string;
  readonly cause: string | null;
  readonly cause_id: string | null;
  readonly attempt_state: string;
  readonly attempt_outcome: string | null;
  readonly sibling_state: string;
  readonly sibling_held: string;
  readonly abandoned_here: string;
}

describe.skipIf(serverUrl === undefined)('two classifiers on one reservation', () => {
  let database: FreshDatabase;
  let rival: Database;
  let fixture: RuntimeFixture;

  beforeAll(async () => {
    database = await createFreshDatabase({
      serverUrl: serverUrl as string,
      part: 'runtime_classifier_race',
    });
    // A second connection, because the first is `max: 1` and two transactions
    // on it would queue in the pool rather than race in the server.
    rival = connect(database.appUrl, { max: 1, source: 'classifier-rival' });
    fixture = await buildFixture(database.app, 'classifier-race');
  }, 120_000);

  afterAll(async () => {
    await rival?.close();
    await database?.drop();
  });

  /** The envelope's two totals and the terminal facts both cases assert. */
  async function terminalFacts(work: RacedHold): Promise<TerminalRow> {
    const rows = await database.app.withBusiness(fixture.businessId, async (tx) =>
      tx.query<TerminalRow>(
        `select res.state, res.classified_cause as cause, res.classified_cause_id::text as cause_id,
                att.state as attempt_state, att.outcome as attempt_outcome,
                sib.state as sibling_state, sib.held_minor::text as sibling_held,
                (select count(*)::text from public.reservations other
                  where other.business_id = res.business_id
                    and other.envelope_id = res.envelope_id
                    and other.state = 'abandoned'
                    and other.classified_cause_id = res.classified_cause_id) as abandoned_here
           from public.reservations res
           join public.attempts att on att.business_id = res.business_id and att.id = $3
           join public.reservations sib on sib.business_id = res.business_id and sib.id = $4
          where res.business_id = $1 and res.id = $2`,
        [fixture.businessId, work.reservationId, work.attemptId, work.siblingReservationId],
      ),
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`no reservation ${work.reservationId}`);
    return row;
  }

  async function totalsOf(work: RacedHold): Promise<{
    readonly held: number;
    readonly actual: number;
    readonly maximum: number;
  }> {
    return await database.app.withBusiness(fixture.businessId, async (tx) =>
      envelopeTotals(tx, work.envelopeId),
    );
  }

  // The regression proper. An owning operation classifies inside the complete
  // lock set; the restart replay reaches the same reservation while that
  // transaction is still open, and must not release the hold a second time.
  it('R1: two classifiers race on one reservation, and the hold is released exactly once', async () => {
    const work = await racedHold(database, fixture);
    const before = await totalsOf(work);
    // Both holds are live, so a second subtraction has room to be silent.
    expect(before).toStrictEqual({ held: 2 * HOLD, actual: 0, maximum: ENVELOPE_CEILING });

    const written = barrier();
    const opened = barrier();

    const owning = database.app.withBusiness(fixture.businessId, async (tx) => {
      const locks = await acquire(tx, lockSetFor(fixture, work));
      const one = await classifyUnderLocks(
        tx,
        {
          reservationId: work.reservationId,
          cause: 'version_superseded',
          causeId: work.versionId,
        },
        locks,
      );
      // Written, not committed: the rival below reads and locks against a
      // transaction that is still open.
      written.release();
      await opened.held;
      return one;
    });

    await written.held;

    const replaying = rival.withBusiness(
      fixture.businessId,
      async (tx) => await replayRecordedTransitions(tx),
    );

    let parkedOn = '';
    let synchronisation: unknown = null;
    try {
      await awaitBlockedOnLock(database);
      parkedOn = await blockedOnRelation(database);
    } catch (error) {
      synchronisation = error;
    } finally {
      // Released here, always, so a synchronisation that never happened reports
      // this case's own failure instead of leaving a transaction parked.
      opened.release();
    }
    const [first, second] = await Promise.allSettled([owning, replaying]);
    if (synchronisation !== null) throw synchronisation;

    // Exactly one release, counted across both backends. Two is the finding.
    const released = [
      ...(first.status === 'fulfilled' ? [first.value] : []),
      ...(second.status === 'fulfilled' ? second.value : ([] as readonly Classification[])),
    ].filter((one) => one.reservationId === work.reservationId && one.released);
    expect(released).toHaveLength(1);

    if (first.status !== 'fulfilled') throw first.reason;
    expect(first.value.released).toBe(true);
    expect(first.value.state).toBe('abandoned');
    expect(first.value.reason).toContain('version_superseded');

    // The loser writes nothing and says so. It holds the complete ordered set,
    // re-reads the affected set under it, finds the reservation is no longer in
    // it, and refuses rather than subtracting a hold the winner has subtracted.
    expect(second.status).toBe('rejected');
    const refusal = second.status === 'rejected' ? String(second.reason) : '';
    expect(refusal).toMatch(/affected set changed under discovery/u);
    // Not the database's last-resort constraint: nothing reached the envelope.
    expect(refusal).not.toMatch(/held_not_negative/u);

    // One subtraction, from `held` only, of exactly this hold.
    const after = await totalsOf(work);
    expect(after).toStrictEqual({ held: before.held - HOLD, actual: 0, maximum: before.maximum });

    // Abandoned once, with one cause and one cause identity, and the sibling
    // hold untouched: the subtraction came off the raced hold and no other.
    expect(await terminalFacts(work)).toStrictEqual({
      state: 'abandoned',
      cause: 'version_superseded',
      cause_id: work.versionId,
      attempt_state: 'abandoned',
      attempt_outcome: 'abandoned',
      sibling_state: 'held',
      sibling_held: String(HOLD),
      abandoned_here: '1',
    });

    // And the observed park: on the cap, the first class in `LOCK_ORDER`, which
    // is the whole point. A replay that took no locks would be parked on the
    // row it was already writing instead.
    expect(parkedOn).toBe('budget_caps');
  }, 60_000);

  // The same race the other way round: the replay wins, and the direct
  // classification under the same locks is the one that loses.
  it('R1: the classifier that loses the race releases nothing and reports the terminal row', async () => {
    const work = await racedHold(database, fixture);
    const before = await totalsOf(work);
    expect(before).toStrictEqual({ held: 2 * HOLD, actual: 0, maximum: ENVELOPE_CEILING });

    const written = barrier();
    const opened = barrier();

    const replaying = database.app.withBusiness(fixture.businessId, async (tx) => {
      const all = await replayRecordedTransitions(tx);
      written.release();
      await opened.held;
      return all;
    });

    await written.held;

    const owning = rival.withBusiness(fixture.businessId, async (tx) => {
      const locks = await acquire(tx, lockSetFor(fixture, work));
      return await classifyUnderLocks(
        tx,
        {
          reservationId: work.reservationId,
          cause: 'version_superseded',
          causeId: work.versionId,
        },
        locks,
      );
    });

    let parkedOn = '';
    let synchronisation: unknown = null;
    try {
      await awaitBlockedOnLock(database);
      parkedOn = await blockedOnRelation(database);
    } catch (error) {
      synchronisation = error;
    } finally {
      opened.release();
    }
    const [first, second] = await Promise.allSettled([replaying, owning]);
    if (synchronisation !== null) throw synchronisation;

    if (first.status !== 'fulfilled') throw first.reason;
    if (second.status !== 'fulfilled') throw second.reason;

    const released = [...first.value, second.value].filter(
      (one) => one.reservationId === work.reservationId && one.released,
    );
    expect(released).toHaveLength(1);
    expect(released[0]?.state).toBe('abandoned');

    // The loser's report: nothing released, the row read as terminal, and a
    // reason that says another transaction got there first rather than a guess.
    expect(second.value.released).toBe(false);
    expect(second.value.state).toBe('abandoned');
    expect(second.value.reason).toMatch(/already abandoned/u);
    expect(second.value.reason).toMatch(/never reclassified or revived/u);

    const after = await totalsOf(work);
    expect(after).toStrictEqual({ held: before.held - HOLD, actual: 0, maximum: before.maximum });

    expect(await terminalFacts(work)).toStrictEqual({
      state: 'abandoned',
      cause: 'version_superseded',
      cause_id: work.versionId,
      attempt_state: 'abandoned',
      attempt_outcome: 'abandoned',
      sibling_state: 'held',
      sibling_held: String(HOLD),
      abandoned_here: '1',
    });

    expect(parkedOn).toBe('budget_caps');
  }, 60_000);
});
