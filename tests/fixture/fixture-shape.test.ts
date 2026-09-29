// SPDX-License-Identifier: AGPL-3.0-only
//
// T4a, `fixture_shape` (split 3.2): the generator seeds an empty database
// through the real commands to the shape of SPEC 10.1, here at a small scale
// so the suite runs in seconds; the full scale is the snapshot build's. Red
// until the generator exists, and the run-events case red until T2a's
// progress record is on the base. Pointed at a database it already seeded,
// it refuses and writes nothing.
//
// Data separation: two businesses, each with its own people and two clients;
// no person, client or record is shared across them.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { seedFixture, type FixtureReport } from './generate.ts';
import { FIXTURE_SHAPE, type FixtureShape } from './shape.ts';

const serverUrl = databaseUrlFromEnvironment();

const SMALL: FixtureShape = {
  ...FIXTURE_SHAPE,
  tasksA: 90,
  tasksB: 9,
  withParent: 30,
  withGrandparent: 8,
  comments: 160,
  hotThread: 30,
  trash: { batch: 10, earlier: 3 },
  lineages: { total: 8, twoVersions: 3, threeVersions: 1 },
  runs: 3,
};

describe.skipIf(serverUrl === undefined)('T4a fixture_shape', () => {
  let db: FreshDatabase;
  let report: FixtureReport;
  const one = async (sql: string, params: unknown[] = []): Promise<number> => {
    const found = await db.admin.execute<{ n: string }>(sql, params);
    return Number(found[0]?.n ?? 0);
  };
  const tasks = `select r.* from public.records r join public.record_types t
      on t.business_id = r.business_id and t.id = r.record_type_id and t.key = 'task'
`;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 't4a' });
    report = await seedFixture(db, SMALL);
  }, 300_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('seeds the task counts per business, the board and its three sections', async () => {
    const per = async (key: string) =>
      await one(
        `select count(*) n from (${tasks}) x join public.businesses b on b.id = x.business_id where b.key = $1`,
        [key],
      );
    expect(await per('alpha')).toBe(SMALL.tasksA);
    expect(await per('bravo')).toBe(SMALL.tasksB);
    const sections = await one(
      `select count(distinct data ->> 'board_section') n from (${tasks}) x
        where data ->> 'board' = $1 and data ->> 'parent' is null`,
      [report.board],
    );
    expect(sections).toBe(SMALL.sections);
  });

  it('seeds the subtask levels and the skewed comment threads', async () => {
    expect(
      await one(`select count(*) n from (${tasks}) x where data ->> 'parent' is not null`),
    ).toBe(SMALL.withParent);
    expect(
      await one(
        `select count(*) n from (${tasks}) c join public.records p
            on p.business_id = c.business_id and p.id::text = c.data ->> 'parent'
          where p.data ->> 'parent' is not null`,
      ),
    ).toBe(SMALL.withGrandparent);
    const threads = await db.admin.execute<{ n: string }>(
      `select count(*) n from public.records r join public.record_types t
          on t.business_id = r.business_id and t.id = r.record_type_id and t.key = 'task_comment'
        group by r.data ->> 'task' order by count(*) desc`,
    );
    const sizes = threads.map((row) => Number(row.n));
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(SMALL.comments);
    expect(sizes[0]).toBe(SMALL.hotThread);
    expect(Math.max(...sizes.slice(1))).toBeLessThanOrEqual(SMALL.threadCeiling);
  });

  it('leaves most slots null: the task type assigns fewer slots than the table carries', () => {
    expect(report.slots.assigned).toBeGreaterThan(0);
    expect(report.slots.assigned).toBeLessThan(report.slots.total);
  });

  it('trashes one subtree in one batch, with descendants trashed in an earlier batch', async () => {
    const batches = await db.admin.execute<{ n: string }>(
      `select count(*) n from public.records where trash_batch_id is not null
        group by trash_batch_id order by count(*) desc`,
    );
    expect(batches.map((row) => Number(row.n))).toStrictEqual([
      SMALL.trash.batch,
      SMALL.trash.earlier,
    ]);
  });

  it('seeds proposal lineages with populations of two and three versions', async () => {
    const versions = await db.admin.execute<{ v: string; n: string }>(
      `select v, count(*) n from (select count(*) v from public.proposal_versions group by lineage_id) x
        group by v order by v`,
    );
    const { total, twoVersions, threeVersions } = SMALL.lineages;
    expect(versions.map((row) => [Number(row.v), Number(row.n)])).toStrictEqual([
      [1, total - twoVersions - threeVersions + SMALL.runs],
      [2, twoVersions],
      [3, threeVersions],
    ]);
  });

  it('gives R4 exactly one grant, scoped to one task record', async () => {
    const grants = await db.admin.execute<{ kind: string; id: string | null }>(
      `select g.scope_kind kind, g.scope_id::text id from public.grants g
         join public.people p on p.business_id = g.business_id and p.id = g.subject_id
        where p.display_name = 'R4'`,
    );
    expect(grants).toStrictEqual([{ kind: 'record', id: report.recordGrantTask }]);
  });

  it('shares no person, client or record across the two businesses', async () => {
    expect(report.people.alpha).toHaveLength(SMALL.peopleA + SMALL.clientsPerBusiness);
    expect(report.people.bravo).toHaveLength(1 + SMALL.clientsPerBusiness);
    const crossed = await one(
      `select count(*) n from public.people a join public.people b
          on a.id = b.id and a.business_id <> b.business_id`,
    );
    expect(crossed).toBe(0);
    expect(
      report.people.alpha.filter((id: string) => report.people.bravo.includes(id)),
    ).toStrictEqual([]);
    const crossGrants = await one(
      `select count(*) n from public.grants g
         left join public.people p on p.id = g.subject_id and p.business_id = g.business_id
         left join public.records r on r.id = g.scope_id and r.business_id = g.business_id
        where p.id is null or (g.scope_kind = 'record' and r.id is null)`,
    );
    expect(crossGrants).toBe(0);
  });

  it('refuses a database it already seeded, and writes nothing', async () => {
    const before = await one('select count(*) n from public.records');
    await expect(seedFixture(db, SMALL)).rejects.toThrow(/DATABASE_NOT_EMPTY/u);
    expect(await one('select count(*) n from public.records')).toBe(before);
  });

  it('picks up and hands back each run, and records its progress (red until T2a)', async () => {
    expect(await one(`select count(*) n from public.attempts`)).toBe(SMALL.runs);
    const events = await one(`select (to_regclass('public.run_events') is not null)::int n`);
    expect(events, 'run_events absent: T2a is not on this base').toBe(1);
    expect(await one(`select count(*) n from public.run_events`)).toBe(SMALL.runs * 2);
  });
});
