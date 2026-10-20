// SPDX-License-Identifier: AGPL-3.0-only
//
// Timer races, each on two connections whose transactions are open at once:
// the application pool is `max: 1`, so two transactions through it alone would
// run one after the other and prove nothing about a race.
//
// - Two starts at once for one person leave one running entry, and the other
//   start is told a timer is running.
// - A stop stamps its end with the time it actually stops the entry, never the
//   time its transaction began. Under read committed a stop can find a timer a
//   newer transaction started after the stop's transaction began, and a stop
//   can wait on the entry's row behind another writer. Ending at the
//   transaction's start would end the first entry before it started, and drop
//   the minutes the second spent waiting. The table also refuses an entry that
//   ends before it starts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertActor, insertBusiness, insertPerson } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import {
  installTaskSpine,
  type InstalledTaskSpine,
} from '../../packages/core-records/src/tasks/install.ts';
import { startTimer, stopTimer } from '../../packages/core-records/src/tasks/time.ts';
import {
  connect,
  type Database,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { createTask } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('timer races: DATABASE_URL is unset, so nothing below ran.');
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A promise a test resolves by hand, which is how a transaction is held open. */
function barrier(): { readonly held: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

interface World {
  readonly db: FreshDatabase;
  readonly second: Database;
  readonly business: string;
  readonly spine: InstalledTaskSpine;
  readonly person: { readonly personId: string; readonly actorId: string };
}

let world: World | undefined;

const seeded = (): World => {
  if (world === undefined) throw new Error('the timer race world was not seeded');
  return world;
};

const inFirst = <T>(work: (tx: TenantQuery) => Promise<T>): Promise<T> =>
  seeded().db.app.withBusiness(seeded().business, work);

const inSecond = <T>(work: (tx: TenantQuery) => Promise<T>): Promise<T> =>
  seeded().second.withBusiness(seeded().business, work);

const freshTask = async (title: string): Promise<string> =>
  await inFirst((tx) => createTask(tx, seeded().spine, { title, parentId: null }));

const started = async (taskId: string): Promise<string> => {
  const answer = await inFirst((tx) => startTimer(tx, { ...seeded().person, taskId }));
  if (answer.kind !== 'started') throw new Error(`the timer did not start: ${answer.kind}`);
  return answer.entryId;
};

const entryOf = async (entryId: string) =>
  (
    await seeded().db.admin.execute<{
      readonly started_at: Date;
      readonly ended_at: Date | null;
    }>(`select started_at, ended_at from public.time_entries where id = $1`, [entryId])
  )[0];

/** Wait, bounded, until some backend in this database is parked on a lock. */
async function waitedOnLock(deadline: number): Promise<boolean> {
  const rows = await seeded().db.admin.execute<{ readonly n: number }>(
    `select count(*)::int as n from pg_stat_activity
      where datname = current_database() and state = 'active' and wait_event_type = 'Lock'`,
  );
  if ((rows[0]?.n ?? 0) > 0) return true;
  if (Date.now() > deadline) return false;
  await delay(25);
  return await waitedOnLock(deadline);
}

/** Two parties: each call waits until both have called, or fails after ten seconds. */
function bothOpen(): () => Promise<void> {
  let arrived = 0;
  const all = barrier();
  return async () => {
    arrived += 1;
    if (arrived === 2) all.release();
    await Promise.race([
      all.held,
      delay(10_000).then(() => {
        throw new Error('the two transactions were never open at once');
      }),
    ]);
  };
}

/** One person starts two tasks' timers, one start on each connection, both open first. */
async function twoStartsAtOnce() {
  const tasks = [await freshTask('first start'), await freshTask('second start')];
  const meet = bothOpen();
  const backends: number[] = [];
  const startOn = (run: typeof inFirst, taskId: string) =>
    run(async (tx) => {
      const [backend] = await tx.query<{ readonly pid: number }>('select pg_backend_pid() as pid');
      backends.push(backend?.pid ?? 0);
      await meet();
      return await startTimer(tx, { ...seeded().person, taskId });
    });
  const answers = await Promise.all([
    startOn(inFirst, tasks[0] ?? ''),
    startOn(inSecond, tasks[1] ?? ''),
  ]);
  const [running] = await seeded().db.admin.execute<{ readonly n: number }>(
    `select count(*)::int as n from public.time_entries
      where person_id = $1 and ended_at is null and deleted_at is null`,
    [seeded().person.personId],
  );
  await inFirst(async (tx) => {
    for (const taskId of tasks) {
      // eslint-disable-next-line no-await-in-loop -- one stop at a time
      await stopTimer(tx, { ...seeded().person, taskId });
    }
  });
  return { backends: new Set(backends).size, answers, running: running?.n };
}

/** A stop whose transaction began before a newer transaction started the timer. */
async function stopBegunBeforeTheStart() {
  const taskId = await freshTask('started late');
  const began = barrier();
  const go = barrier();
  const stopping = inFirst(async (tx) => {
    // The transaction's clock is fixed here, before the timer exists.
    await tx.query('select 1');
    began.release();
    await go.held;
    return await stopTimer(tx, { ...seeded().person, taskId });
  });
  await began.held;
  await delay(20);
  const start = await inSecond((tx) => startTimer(tx, { ...seeded().person, taskId }));
  go.release();
  return { start, stop: await stopping };
}

/** A stop that waits three seconds on its entry's row, 58 seconds into the timer. */
async function stopBehindALock() {
  const taskId = await freshTask('waited on');
  const entryId = await started(taskId);
  await seeded().db.admin.execute(
    `update public.time_entries set started_at = clock_timestamp() - interval '58 seconds'
      where id = $1`,
    [entryId],
  );
  const locked = barrier();
  const open = barrier();
  const holding = inSecond(async (tx) => {
    await tx.query(`select id from public.time_entries where id = $1 for update`, [entryId]);
    locked.release();
    await open.held;
  });
  await locked.held;
  const stopping = inFirst((tx) => stopTimer(tx, { ...seeded().person, taskId }));
  const waited = await waitedOnLock(Date.now() + 10_000);
  await delay(3_000);
  const [released] = await seeded().db.admin.execute<{ readonly at: Date }>(
    'select clock_timestamp() as at',
  );
  open.release();
  await holding;
  return { entryId, waited, released: released?.at, stop: await stopping };
}

beforeAll(async () => {
  if (serverUrl === undefined) return;
  const db = await createFreshDatabase({ part: 'tmr' });
  const second = connect(db.appUrl, { source: 'runtime' });
  const business = await insertBusiness(db.app, 'timer-races');
  world = await db.app.withBusiness(business, async (tx) => {
    const spine = await installTaskSpine(tx);
    const personId = await insertPerson(tx, 'a timer');
    const actorId = await insertActor(tx, personId);
    return { db, second, business, spine, person: { personId, actorId } };
  });
}, 60_000);

afterAll(async () => {
  await world?.second.close();
  await world?.db.drop();
});

describe.skipIf(serverUrl === undefined)('one running timer per person, under a race', () => {
  it('two starts at once leave exactly one running entry', async () => {
    const { backends, answers, running } = await twoStartsAtOnce();
    expect(backends, 'the two starts ran on two backends').toBe(2);
    expect(answers.map((answer) => answer.kind).toSorted()).toStrictEqual(['running', 'started']);
    expect(running).toBe(1);
  }, 30_000);
});

describe.skipIf(serverUrl === undefined)('a timer stop ends at the time it stops', () => {
  it('a stop begun before a newer start committed ends that timer after it started', async () => {
    const { start, stop } = await stopBegunBeforeTheStart();
    if (start.kind !== 'started') throw new Error(`the timer did not start: ${start.kind}`);
    expect(stop).toStrictEqual({ kind: 'stopped', entryId: start.entryId, minutes: 1 });
    const entry = await entryOf(start.entryId);
    expect(entry?.ended_at?.getTime()).toBeGreaterThanOrEqual(entry?.started_at.getTime() ?? 0);
  });

  it('a stop that waits on its entry ends after the wait and counts the minutes waited', async () => {
    const { entryId, waited, released, stop } = await stopBehindALock();
    expect(waited, 'the stop waited on the held entry').toBe(true);
    expect(stop).toStrictEqual({ kind: 'stopped', entryId, minutes: 2 });
    const entry = await entryOf(entryId);
    expect(entry?.ended_at?.getTime()).toBeGreaterThanOrEqual(released?.getTime() ?? Infinity);
  }, 30_000);

  it('the table refuses an entry that ends before it starts', async () => {
    const entryId = await started(await freshTask('inverted'));
    await expect(
      seeded().db.admin.execute(
        `update public.time_entries
            set ended_at = started_at - interval '1 millisecond', minutes = 1
          where id = $1`,
        [entryId],
      ),
    ).rejects.toThrow(/time_entries_ends_after_start/u);
  });
});
