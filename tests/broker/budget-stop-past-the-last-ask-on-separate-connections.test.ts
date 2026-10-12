// SPDX-License-Identifier: AGPL-3.0-only
//
// A call past the ceiling after a run's third ask reads the ask count, then
// ends the run, its lease and delegation, and tells a person once
// (`raiseBudgetWait`). Two such calls on one lease, each on a connection of
// its own, meet behind a third holding the lease row; and one call's commit
// is cut at a named point, then the call is made again. Either way the run
// ends once, no fourth ask is raised, one alert is raised and nothing is sent.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it as vitestIt } from 'vitest';
import { callModel } from '../../packages/core-custody/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { hold } from '../support/lock-wait-race.ts';
import {
  cutProxy,
  liveWork,
  racer,
  settle,
  type CutPoint,
  type Work,
} from '../runtime/schedules-harness.ts';
import {
  broker,
  caller,
  noDatabase,
  requestFor,
  s,
  stepOf,
  useBrokerWorld,
  world,
} from './broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('lastaskrace');

/** Under the replay operation's priced maximum of 500: no call fits. */
const UNDER_ONE_CALL = 400;

/** Work whose run has asked three times already, the last the consolidated decision. */
async function spentWork(title: string): Promise<Work> {
  const work = await liveWork(s, title, UNDER_ONE_CALL);
  await stepOf(work);
  const leaseId = work.picked['leaseId'];
  const [run] = await s.db.admin.execute<{ run_id: string }>(
    'select run_id from public.leases where id = $1',
    [leaseId],
  );
  for (const [askNumber, kind] of [
    [1, 'stop'],
    [2, 'stop'],
    [3, 'consolidated'],
  ] as const) {
    // One ask at a time, each numbered after the last.
    // eslint-disable-next-line no-await-in-loop
    await s.db.admin.execute(
      `insert into public.budget_asks
         (business_id, id, run_id, reservation_id, lease_id, decision_id, ask_number, kind,
          ceiling_minor, spent_minor, currency)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 400, 0, 'AUD')`,
      [
        s.business,
        randomUUID(),
        run?.run_id,
        work.decision['reservationId'],
        leaseId,
        work.decision['decisionId'],
        askNumber,
        kind,
      ],
    );
  }
  return work;
}

/** The run, its lease and delegation, its asks and the alerts on its task. */
async function endOf(work: Work) {
  const [after] = await s.db.admin.execute(
    `select run.state as run, l.state as lease, d.revocation_cause as cause,
            (select count(*)::int from public.budget_asks k where k.run_id = run.id) as asks,
            (select count(*)::int from public.alerts a
              where a.task_id = run.task_id and a.cause_id = l.reservation_id) as alerts
       from public.leases l
       join public.planned_runs run on run.id = l.run_id
       join public.delegations d on d.id = l.delegation_id
      where l.id = $1`,
    [work.picked['leaseId']],
  );
  return after;
}

const ENDED = { run: 'cancelled', lease: 'released', cause: 'work_retired', asks: 3, alerts: 1 };

/** The backend of each racer's one connection. */
async function pidsOf(...databases: readonly Database[]): Promise<readonly number[]> {
  return await Promise.all(
    databases.map(
      async (database) =>
        await database.withBusiness(s.business, async (tx) => {
          const [me] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
          return Number(me?.pid);
        }),
    ),
  );
}

const callOn = async (database: Database, work: Work) =>
  await callModel(database, s.business, caller(work), requestFor(work), broker);

it('two calls past the last ask at once end the run once and raise one alert', async () => {
  const work = await spentWork('last ask raced');
  world.provider.mode('answer');
  const sent = world.provider.seen.length;
  const holder = await hold(s.db, async (execute) => {
    await execute('select id from public.leases where id = $1 for update', [
      work.picked['leaseId'],
    ]);
  });
  const first = racer(s);
  const second = racer(s);
  try {
    const pids = await pidsOf(first, second);
    const a = callOn(first, work);
    const b = callOn(second, work);
    for (let attempt = 0; attempt < 400; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
      const waiting = await s.db.admin.execute<{ n: number }>(
        // Each waits on the holder, or on the other call queued behind it.
        `select count(*)::int as n from pg_stat_activity a
          where a.datname = current_database() and a.wait_event_type = 'Lock'
            and pg_blocking_pids(a.pid) && array[$1::int, $2::int, $3::int]`,
        [holder.pid, ...pids],
      );
      if ((waiting[0]?.n ?? 0) >= 2) break;
      if (attempt === 399) throw new Error('the two calls never both waited on the lease');
      // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
      await delay(25);
    }
    await holder.letGo();
    const results = await settle([a, b]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    for (const result of results) {
      if (result.status === 'fulfilled') expect(result.value.ok).toBe(false);
    }
  } finally {
    await holder.letGo();
    await first.close();
    await second.close();
  }
  expect(world.provider.seen.length).toBe(sent);
  expect(await endOf(work)).toEqual(ENDED);
});

it.each<CutPoint>(['before-commit', 'after-commit'])(
  'a call past the last ask whose commit is cut %s, made again, ends the run once',
  async (point) => {
    const work = await spentWork(`last ask cut ${point}`);
    world.provider.mode('answer');
    const sent = world.provider.seen.length;
    const before = await endOf(work);
    const proxy = await cutProxy(s.db.appUrl, point);
    const cut = racer(s, proxy.url);
    try {
      const [interrupted] = await settle([callOn(cut, work)]);
      expect(proxy.cut(), `the relay never reached its ${point} point`).toBe(true);
      expect(interrupted?.status).toBe('rejected');
    } finally {
      // A client whose socket the relay killed may never finish ending: give it a second.
      await Promise.race([cut.close().catch(() => null), delay(1_000)]);
      await proxy.close();
    }
    expect(await endOf(work)).toEqual(point === 'after-commit' ? ENDED : before);
    const again = await callOn(s.db.app, work);
    expect(again.ok).toBe(false);
    expect(world.provider.seen.length).toBe(sent);
    expect(await endOf(work)).toEqual(ENDED);
  },
);
