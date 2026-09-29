// SPDX-License-Identifier: AGPL-3.0-only
//
// T3e2: one report per outage, not one alert per run. `one_report_per_outage`:
// fifty runs dropped by one injected provider outage, ten at a time, give
// exactly one report naming the cause, its window, all fifty runs and which
// came back, and no per-run alert for that cause. A second cause is its own
// report; a drop after the window has passed opens a new one. The same cause
// in two businesses gives each its own report, and neither sees the other's;
// a client and a member with no grant see none.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  approve,
  asAgent,
  asPerson,
  createTask,
  freshPurpose,
  handbackBody,
  openSchedules,
  pickup,
  proposeBody,
  revisionOf,
  rows,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';
import { cq8World } from './t2d-harness.ts';
import { openSecond } from './t3b-harness.ts';

const url = databaseUrlFromEnvironment();

interface Picked {
  readonly taskId: string;
  readonly picked: Detail;
  readonly credential: string;
}

async function work(on: Schedules): Promise<Picked> {
  const taskId = await createTask(on, `t3e2 ${randomUUID()}`);
  const body = {
    ...proposeBody(taskId, await revisionOf(on, taskId), {
      purpose: freshPurpose(),
      maximumMinor: 2_500,
    }),
    step: { kind: 'synthetic_comment', payload: {} },
  };
  const decision = await approve(on, appliedDetail(await asPerson(on, body), 'task.propose'));
  const picked = await pickup(on, decision['reservationId']);
  return { taskId, picked, credential: String(picked['credential']) };
}

async function dropped(on: Schedules, w: Picked, dropCause: string): Promise<void> {
  appliedDetail(
    await asAgent(
      on,
      { ...handbackBody(w.picked), outcome: 'dropped', report: { dropCause } },
      w.credential,
    ),
    'task.handback',
  );
}

/** `count` runs dropped for one cause, `batch` hand-backs at a time. */
async function outage(on: Schedules, count: number, cause: string): Promise<Picked[]> {
  const all: Picked[] = [];
  for (let at = 0; at < count; at += 10) {
    // Batches, so the report is joined by concurrent drops.
    // eslint-disable-next-line no-await-in-loop
    const batch = await Promise.all(
      Array.from({ length: Math.min(10, count - at) }, async () => await work(on)),
    );
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(batch.map(async (w) => await dropped(on, w, cause)));
    all.push(...batch);
  }
  return all;
}

async function queueOf(on: Schedules, who: Member): Promise<Record<string, unknown>> {
  return (await executeRead(on.db.app, on.business, who.presented, {
    read: 'task.queue',
  } as never)) as Record<string, unknown>;
}

const reports = async (on: Schedules) =>
  await rows<{ id: string; cause: string; runs: string; closed: boolean }>(
    on,
    `select r.id, r.cause, (select count(*) from public.outage_runs o
                              where o.business_id = r.business_id and o.outage_id = r.id)::text as runs,
            (r.closed_at is not null) as closed
       from public.outage_reports r where r.business_id = $1 order by r.opened_at, r.id`,
    [on.business],
  );

/** Every alert in the business: a drop raises none of any kind. */
const droppedAlerts = async (on: Schedules): Promise<number> =>
  (await rows(on, 'select 1 from public.alerts where business_id = $1', [on.business])).length;

describe.skipIf(url === undefined)('T3e2: one report per outage', { timeout: 180_000 }, () => {
  let s: Schedules;
  let other: Schedules;

  beforeAll(async () => {
    s = await openSchedules('t3e2', 100_000_000);
    other = await openSecond(s, 't3e2-away');
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it('one_report_per_outage: fifty runs dropped by one outage give one report and no per-run alert', async () => {
    const fifty = await outage(s, 50, 'provider_unavailable');
    expect(await reports(s)).toMatchObject([
      { cause: 'provider_unavailable', runs: '50', closed: false },
    ]);
    expect(await droppedAlerts(s)).toBe(0);

    const answer = await queueOf(s, s.decider);
    const [report] = answer['outages'] as readonly Record<string, unknown>[];
    expect(report).toMatchObject({ cause: 'provider_unavailable', fault: 'provider' });
    expect(typeof report?.['openedAt']).toBe('string');
    expect(typeof report?.['lastDropAt']).toBe('string');
    const runs = report?.['runs'] as readonly { taskId: string; reactivated: boolean }[];
    expect(runs.map((run) => run.taskId).toSorted()).toStrictEqual(
      fifty.map((w) => w.taskId).toSorted(),
    );
    expect(runs.every((run) => run.reactivated)).toBe(true);
  });

  it('another cause is its own report, and a drop after the window opens a new one', async () => {
    await outage(s, 2, 'connection_lost');
    await s.db.admin.execute(
      `update public.outage_reports set opened_at = opened_at - interval '1 hour',
              last_drop_at = last_drop_at - interval '1 hour'
        where business_id = $1 and cause = 'connection_lost'`,
      [s.business],
    );
    await outage(s, 1, 'connection_lost');
    const byCause = (await reports(s)).filter((one) => one.cause === 'connection_lost');
    expect(byCause).toMatchObject([
      { runs: '2', closed: true },
      { runs: '1', closed: false },
    ]);
    expect(await droppedAlerts(s)).toBe(0);
  });

  it('business to business: one cause in two businesses gives each its own report, and neither sees the other', async () => {
    const away = await outage(other, 3, 'provider_unavailable');
    expect(await reports(other)).toMatchObject([{ cause: 'provider_unavailable', runs: '3' }]);
    const here = JSON.stringify(await queueOf(s, s.decider));
    for (const w of away) expect(here).not.toContain(w.taskId);
    const there = (await queueOf(other, other.decider))['outages'] as readonly Record<
      string,
      unknown
    >[];
    expect(there).toHaveLength(1);
    expect(JSON.stringify(there)).not.toContain(s.business);
  });

  it('a client and a member with no grant see no outage', async () => {
    const [one] = await outage(s, 1, 'provider_unavailable');
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, s.decider, 'share');
    });
    const elsewhere = await createTask(s, `t3e2 elsewhere ${randomUUID()}`);
    const client = await cq8World(s).client(s.business, s.decider, 't3e2-client', elsewhere);
    const seen = await queueOf(s, client);
    expect(seen['outages'] ?? []).toStrictEqual([]);
    expect(JSON.stringify(seen)).not.toContain(one?.taskId);
    const idle = await enrol(s.db.app, s.business, 't3e2-idle');
    expect(await queueOf(s, idle)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
  });
});
