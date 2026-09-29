// SPDX-License-Identifier: AGPL-3.0-only
//
// T4a, `fixture_shape` (split 3.2): the generator seeds an empty database
// through the real commands to SPEC 10.1's shape, here at a small scale so
// the suite runs in seconds; the full scale is the snapshot build's. The
// run-events case is red until T2a's progress record is on the base. Pointed
// at a database it already seeded, the generator refuses and writes nothing.
//
// Data separation: two businesses, each with its own people and two clients;
// no person, grant or record crosses between them.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';
import { seedFixture, type FixtureReport } from './generate.ts';
import { FIXTURE_SHAPE } from './shape.ts';

const serverUrl = databaseUrlFromEnvironment();

const SMALL = {
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
  steps: 20,
  runEvents: 60,
};

const TASKS = `select r.* from public.records r join public.record_types t
    on t.business_id = r.business_id and t.id = r.record_type_id and t.key = 'task'`;

describe.skipIf(serverUrl === undefined)('T4a fixture_shape', () => {
  let db: FreshDatabase;
  let report: FixtureReport;
  const counts = async (sql: string, params: unknown[] = []): Promise<number[]> =>
    (await db.admin.execute<{ n: string }>(sql, params)).map((row) => Number(row.n));
  const one = async (sql: string, params: unknown[] = []): Promise<number> =>
    (await counts(sql, params))[0] ?? 0;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 't4a' });
    report = await seedFixture(db, SMALL);
  }, 300_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('seeds the tasks of each business, the board and its sections', async () => {
    const per = `select count(*) n from (${TASKS}) x
      join public.businesses b on b.id = x.business_id group by b.key order by b.key`;
    expect(await counts(per)).toStrictEqual([SMALL.tasksA, SMALL.tasksB]);
    const sections = `select count(distinct data ->> 'board_section') n from (${TASKS}) x
      where data ->> 'board' = $1 and data ->> 'parent' is null`;
    expect(await one(sections, [report.board])).toBe(SMALL.sections);
  });

  it('seeds three task levels and skewed comment threads', async () => {
    const parented = `select count(*) n from (${TASKS}) x where data ->> 'parent' is not null`;
    expect(await one(parented)).toBe(SMALL.withParent);
    const grand = `select count(*) n from (${TASKS}) c join public.records p
      on p.business_id = c.business_id and p.id::text = c.data ->> 'parent'
      where p.data ->> 'parent' is not null`;
    expect(await one(grand)).toBe(SMALL.withGrandparent);
    const threads = await counts(
      `select count(*) n from public.records r join public.record_types t
          on t.business_id = r.business_id and t.id = r.record_type_id and t.key = 'task_comment'
        group by r.data ->> 'task' order by count(*) desc`,
    );
    expect(threads.reduce((a, b) => a + b, 0)).toBe(SMALL.comments);
    expect(threads[0]).toBe(SMALL.hotThread);
    expect(Math.max(...threads.slice(1))).toBeLessThanOrEqual(SMALL.threadCeiling);
  });

  it('leaves most slots null: the task type assigns fewer slots than exist', () => {
    expect(report.slots.assigned).toBeGreaterThan(0);
    expect(report.slots.assigned).toBeLessThan(report.slots.total);
  });

  it('Sol proof, criterion 2: the fixture occupies exactly 24 of 38 task slots', () => {
    expect(report.slots).toStrictEqual({ assigned: 24, total: 38 });
  });

  it('trashes one subtree in one batch, after part of it went in an earlier one', async () => {
    const batches = `select count(*) n from public.records where trash_batch_id is not null
      group by trash_batch_id order by count(*) desc`;
    expect(await counts(batches)).toStrictEqual([SMALL.trash.batch, SMALL.trash.earlier]);
  });

  it('seeds proposal lineages of one, two and three versions', async () => {
    const lengths = `select count(*) n from (select count(*) v from public.proposal_versions
      group by lineage_id) x group by v order by v`;
    const { total, twoVersions, threeVersions } = SMALL.lineages;
    const single = total - twoVersions - threeVersions + SMALL.runs;
    expect(await counts(lengths)).toStrictEqual([single, twoVersions, threeVersions]);
  });

  it('Sol proof, criterion 2: the fixture honours requested step and event load', async () => {
    expect(await one('select count(*) n from public.planned_steps')).toBe(SMALL.steps);
    expect(await one('select count(*) n from public.run_events')).toBe(SMALL.runEvents);
    expect(report.heldBack).toStrictEqual([]);
  });

  it('gives R4 exactly one grant, scoped to one task', async () => {
    const grants = await db.admin.execute(
      `select g.scope_kind kind, g.scope_id::text id from public.grants g
         join public.people p on p.business_id = g.business_id and p.id = g.subject_id
        where p.display_name = 'R4'`,
    );
    expect(grants).toEqual([{ kind: 'record', id: report.recordGrantTask }]);
  });

  it('keeps each business its own people, clients and grants', async () => {
    expect(report.people.alpha).toHaveLength(SMALL.peopleA + SMALL.clientsPerBusiness);
    expect(report.people.bravo).toHaveLength(1 + SMALL.clientsPerBusiness);
    const shared = `select count(*) n from public.people a join public.people b
      on a.id = b.id and a.business_id <> b.business_id`;
    expect(await one(shared)).toBe(0);
    const crossing = `select count(*) n from public.grants g
       left join public.people p on p.id = g.subject_id and p.business_id = g.business_id
       left join public.records r on r.id = g.scope_id and r.business_id = g.business_id
      where p.id is null or (g.scope_kind = 'record' and r.id is null)`;
    expect(await one(crossing)).toBe(0);
  });

  const readAs = async (business: BusinessId, who: VerifiedSubject, recordId: string) => {
    const answer = await executeRead(db.app, business, who, { read: 'task.read', recordId });
    return isCommandRefusal(answer) ? answer.code : 'read';
  };

  it('T4 isolation: business to business', async () => {
    const { alpha, bravo, bravoLead, clients } = report.callers;
    const [alphaShared, bravoShared] = clients;
    expect(await readAs(bravo, bravoLead, bravoShared?.task ?? '')).toBe('read');
    expect(await readAs(bravo, bravoLead, alphaShared?.task ?? '')).toBe('NOT_FOUND');
    expect(await readAs(alpha, bravoLead, alphaShared?.task ?? '')).not.toBe('read');
  });

  it('T4 isolation: client to client', async () => {
    const { clients } = report.callers;
    const reads = clients.flatMap((reader) => [
      readAs(reader.business, reader.presented, reader.task),
      ...clients
        .filter((other) => other !== reader)
        .flatMap((other) => [
          readAs(reader.business, reader.presented, other.task),
          readAs(other.business, reader.presented, other.task),
        ]),
    ]);
    const own = [true, ...Array.from({ length: 2 * (clients.length - 1) }, () => false)];
    const seen = (await Promise.all(reads)).map((answer) => answer === 'read');
    expect(seen).toStrictEqual(clients.flatMap(() => own));
  });

  it('T4 isolation: person to person', async () => {
    const { alpha, r4, clients } = report.callers;
    expect(await readAs(alpha, r4, report.recordGrantTask)).toBe('read');
    const sibling = await readAs(alpha, r4, clients[0]?.task ?? '');
    expect(sibling).not.toBe('read');
    expect(sibling).toBe(await readAs(alpha, r4, randomUUID()));
  });

  it('refuses a database it already seeded, and writes nothing', async () => {
    const before = await one('select count(*) n from public.records');
    await expect(seedFixture(db, SMALL)).rejects.toThrow(/DATABASE_NOT_EMPTY/u);
    expect(await one('select count(*) n from public.records')).toBe(before);
  });

  it('picks up and hands back each run, and records its progress (red until T2a)', async () => {
    expect(await one('select count(*) n from public.attempts')).toBe(SMALL.runs);
    const present = `select (to_regclass('public.run_events') is not null)::int n`;
    expect(await one(present), 'run_events absent: T2a is not on this base').toBe(1);
    expect(await one('select count(*) n from public.run_events')).toBe(SMALL.runs * 2);
  });
});
