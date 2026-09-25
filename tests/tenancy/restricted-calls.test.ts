// SPDX-License-Identifier: AGPL-3.0-only
//
// I06 and M02 at the full schema: an actual select, insert, update and delete
// by every restricted caller against every table, and an actual call of every
// function, with the answer the contract expects asserted and the table's
// contents unchanged after every write.
//
// The world is the acceptance world: two businesses, the cast, and a journey
// walked through the real application to a handback, so the own business holds
// rows in the tables that matter and "the other tenant sees none" is asked of
// rows that exist. A table the journey leaves empty is named in the tally as
// empty, because filtering nothing proves less than filtering something.
//
// The per-prefix half is `restricted-calls-prefixes.test.ts`.

import { readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { walkTheJourney, walkTheOtherLineages } from '../acceptance/restart-harness.ts';
import { APPLICATION_ROLE } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';
import {
  APPLICATION_CALLERS,
  APPLICATION_EXECUTES,
  WORKER_ROLE,
  APPLICATION_GRANTS,
  OPERATIONS,
  callFor,
  catalogueFunctions,
  catalogueTables,
  classify,
  copyStatement,
  describeOutcome,
  expectedOutcome,
  fingerprint,
  meets,
  openCallers,
  ownRowJson,
  ownRows,
  statementFor,
  tally,
  type CallerName,
  type CatalogueFunction,
  type CatalogueTable,
  type Callers,
  type Outcome,
} from './restricted-calls-cases.ts';

/**
 * One owner-written row per business in the three tables the journey leaves
 * empty, so their filtering is asked of rows that exist (TC:108). Written by
 * this suite's own setup rather than the shared world, so no other suite's
 * world assertions move.
 */
const UNREACHED: Readonly<Record<string, string>> = {
  'public.person_identifiers': `insert into public.person_identifiers
       (business_id, id, person_id, kind, value, observed_value, source_system)
     select business_id, gen_random_uuid(), id, 'email', 'restricted-calls-seed',
            'restricted-calls-seed', 'restricted_calls'
       from public.people where business_id = $1 order by id limit 1 returning 1`,
  // A business in the world holds one person, so the absorbed one is written here.
  'public.person_merges': `with absorbed as (
       insert into public.people (business_id, id, display_name)
       values ($1, gen_random_uuid(), 'restricted calls absorbed') returning business_id, id)
     insert into public.person_merges
       (business_id, id, surviving_person_id, absorbed_person_id, decided_by_actor_id, evidence)
     select a.business_id, gen_random_uuid(), p.id, a.id, actor.id, 'restricted_calls seed'
       from absorbed a
       join public.people p on p.business_id = a.business_id
       join public.actors actor on actor.business_id = a.business_id
      order by p.id, actor.id limit 1 returning 1`,
  'public.record_links': `insert into public.record_links
       (business_id, id, link_type, from_record_id, to_record_id)
     select a.business_id, gen_random_uuid(), 'restricted_calls', a.id, b.id
       from public.records a
       join public.records b on b.business_id = a.business_id and b.id > a.id
      where a.business_id = $1 order by a.id, b.id limit 1 returning 1`,
};

/** Thrown to end the wrapper's transaction once the insert has answered. */
class RolledBack extends Error {
  readonly n: number;
  constructor(n: number) {
    super('rolled back');
    this.n = n;
  }
}

const TABLE_CALLERS: readonly CallerName[] = [
  'login in the wrapper, own tenant',
  'login in the wrapper, other tenant',
  'login outside the wrapper',
  'application group outside the wrapper',
  'outsider in the wrapper',
  'outsider outside the wrapper',
  'worker',
];

/**
 * Every role on the cluster that is not the server's own, sorted into the
 * classes a call is made for. A role that fits none of them is returned as
 * `unclassified` and the suites fail on it: a role nobody decided about is the
 * one this proof exists for.
 */
async function roleClasses(
  admin: AdminConnection,
): Promise<Readonly<Record<string, readonly string[]>>> {
  const rows = await admin.execute<{ rolname: string; class: string }>(
    `select r.rolname,
            case when r.rolsuper then 'owner'
                 when r.rolname = $1 then 'application group'
                 when pg_has_role(r.rolname, $1, 'member') then 'application login'
                 when r.rolname = $2 then 'worker'
                 when r.rolcanlogin and not r.rolbypassrls and not r.rolcreaterole
                      and not r.rolcreatedb then 'outsider'
                 else 'unclassified' end as class
       from pg_roles r where r.rolname !~ '^pg_' order by 1`,
    [APPLICATION_ROLE, WORKER_ROLE],
  );
  const classes: Record<string, string[]> = {};
  for (const row of rows) (classes[row.class] ??= []).push(row.rolname);
  return classes;
}

describe.skipIf(serverUrl === undefined)('I06/M02: restricted calls at the full schema', () => {
  let world: World;
  let callers: Callers;
  let tables: readonly CatalogueTable[];
  let functions: readonly CatalogueFunction[];
  const executed: string[] = [];

  beforeAll(async () => {
    world = await createWorld('rcf');
    await walkTheOtherLineages(world);
    await walkTheJourney(world);
    for (const business of [world.alpha, world.bravo]) {
      for (const [table, text] of Object.entries(UNREACHED)) {
        // oxlint-disable-next-line no-await-in-loop
        const seeded = await world.db.admin.execute(text, [business]);
        if (seeded.length !== 1) throw new Error(`no seed row for ${table}`);
      }
    }
    callers = openCallers(world.db, { own: world.alpha, other: world.bravo });
    tables = await catalogueTables(world.db.admin);
    functions = await catalogueFunctions(world.db.admin);
  }, 180_000);

  afterAll(async () => {
    tally('0020 full', executed);
    await callers?.close();
    await world?.close();
  });

  // Every migration on disk, read from the directory rather than counted here,
  // so the next migration needs no edit to this suite (docs/local/DATA.md, "What the schema is").
  it('reads every migration on disk, and a table set the contract names exactly', async () => {
    const applied = await world.db.admin.execute<{ version: string }>(
      'select version from ops.schema_migrations order by version',
    );
    expect(applied.map((row) => `${row.version}.sql`)).toStrictEqual(
      readdirSync('migrations')
        .filter((name) => name.endsWith('.sql'))
        .toSorted(),
    );
    expect(tables.map((table) => table.qualified)).toStrictEqual(
      Object.keys(APPLICATION_GRANTS).toSorted(),
    );
    expect(tables.filter((table) => table.kind !== 'r')).toStrictEqual([]);
    for (const table of tables.filter((each) => each.tenant)) {
      expect({ table: table.qualified, forced: table.forced }).toStrictEqual({
        table: table.qualified,
        forced: true,
      });
    }
  });

  it('sorts every role on the cluster into a class a call is made for', async () => {
    const classes = await roleClasses(world.db.admin);
    expect(classes['unclassified'] ?? []).toStrictEqual([]);
    expect(classes['application group']).toStrictEqual([APPLICATION_ROLE]);
    expect(classes['worker']).toStrictEqual(['ops_astro_worker']);
    expect(classes['application login']).toContain(world.db.loginRole);
    expect(classes['outsider']).toContain(world.db.restrictedRole);
  });

  it('answers every caller on every table as the contract says, and no write lands', async () => {
    const wrong: string[] = [];
    for (const table of tables) {
      // oxlint-disable-next-line no-await-in-loop
      const own = await ownRows(world.db.admin, table, world.alpha);
      for (const operation of OPERATIONS) {
        const text = statementFor(table, operation);
        for (const caller of TABLE_CALLERS) {
          // One statement at a time: each answer is read against the state
          // the one before it left, and a write that landed would move it.
          // oxlint-disable-next-line no-await-in-loop
          const before = await fingerprint(world.db.admin, table.qualified);
          // oxlint-disable-next-line no-await-in-loop
          const outcome = await callers.call(caller, text, table.tenant ? [world.alpha] : []);
          // oxlint-disable-next-line no-await-in-loop
          const after = await fingerprint(world.db.admin, table.qualified);
          const expected = expectedOutcome(caller, table, operation, own);
          const line = `${table.qualified}\t${operation}\t${caller}\t${describeOutcome(outcome)}\town=${String(own)}`;
          executed.push(line);
          if (!meets(expected, outcome)) wrong.push(`${line}\texpected ${expected}`);
          if (before !== after) wrong.push(`${line}\tthe table changed`);
        }
      }
    }
    expect(wrong).toStrictEqual([]);
    expect(executed.length).toBe(tables.length * OPERATIONS.length * TABLE_CALLERS.length);
  }, 120_000);

  it('refuses a whole own-business row re-sent by every other caller, and it does not land', async () => {
    const wrong: string[] = [];
    let copied = 0;
    for (const table of tables.filter((each) => each.tenant)) {
      // oxlint-disable-next-line no-await-in-loop
      const row = await ownRowJson(world.db.admin, table, world.alpha);
      if (row === undefined) continue;
      copied += 1;
      for (const caller of TABLE_CALLERS.slice(1)) {
        // oxlint-disable-next-line no-await-in-loop
        const before = await fingerprint(world.db.admin, table.qualified);
        // oxlint-disable-next-line no-await-in-loop
        const outcome = await callers.call(caller, copyStatement(table), [row]);
        // oxlint-disable-next-line no-await-in-loop
        const after = await fingerprint(world.db.admin, table.qualified);
        const expected = expectedOutcome(caller, table, 'insert', 0);
        const line = `${table.qualified}\tinsert copy\t${caller}\t${describeOutcome(outcome)}`;
        executed.push(line);
        if (!meets(expected, outcome)) wrong.push(`${line}\texpected ${expected}`);
        if (before !== after) wrong.push(`${line}\tthe table changed`);
      }
    }
    expect(wrong).toStrictEqual([]);
    expect(copied).toBeGreaterThan(0);
  }, 120_000);

  it('holds rows for the own business in the tables the journey reaches', async () => {
    const empty: string[] = [];
    for (const table of tables) {
      // oxlint-disable-next-line no-await-in-loop
      if ((await ownRows(world.db.admin, table, world.alpha)) === 0) empty.push(table.qualified);
    }
    tally('0020 full empty', empty);
    // Recorded rather than required: the tally names every table whose
    // filtering was asked of no rows. The tables the definer guards are not
    // among them, because that case below needs a row to refuse.
    expect(empty).not.toContain('public.handback_reports');
    expect(empty).not.toContain('public.records');
    for (const table of Object.keys(UNREACHED)) expect(empty).not.toContain(table);
  });

  it('admits an own-business insert on every table the application inserts into', async () => {
    // The positive control TC:108 names, counted: the login, through the
    // production wrapper in its own tenant, inserts a whole own row and the
    // insert lands. The owner first sets that row aside with triggers and
    // foreign keys off, so the table's own uniqueness does not answer instead;
    // the wrapper's transaction is rolled back, and the owner puts the row
    // back exactly, which the fingerprint shows.
    const inserting = tables.filter(
      (table) => table.tenant && (APPLICATION_GRANTS[table.qualified] ?? '').includes('i'),
    );
    const admitted: string[] = [];
    const wrong: string[] = [];
    const asOwner = async (text: string, row: string): Promise<number> =>
      await world.db.admin.transaction(async (execute) => {
        await execute('set local session_replication_role = replica');
        return (await execute(text, [row])).length;
      });
    for (const table of inserting) {
      // oxlint-disable-next-line no-await-in-loop
      const row = await ownRowJson(world.db.admin, table, world.alpha);
      if (row === undefined) {
        wrong.push(`${table.qualified}\tno own row to insert`);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      const before = await fingerprint(world.db.admin, table.qualified);
      // oxlint-disable-next-line no-await-in-loop
      const aside = await asOwner(
        `delete from ${table.qualified} t where row_to_json(t)::text = $1 returning 1`,
        row,
      );
      let outcome: Outcome;
      try {
        // oxlint-disable-next-line no-await-in-loop
        await world.db.app.withBusiness(world.alpha, async (tx) => {
          throw new RolledBack((await tx.query(copyStatement(table), [row])).length);
        });
        outcome = { kind: 'other', code: '', message: 'committed' };
      } catch (error) {
        outcome = error instanceof RolledBack ? { kind: 'rows', n: error.n } : classify(error);
      } finally {
        // oxlint-disable-next-line no-await-in-loop
        await asOwner(copyStatement(table), row);
      }
      // oxlint-disable-next-line no-await-in-loop
      const after = await fingerprint(world.db.admin, table.qualified);
      const line = `${table.qualified}\town insert\tlogin in the wrapper, own tenant\t${describeOutcome(outcome)}`;
      admitted.push(line);
      if (aside !== 1) wrong.push(`${line}\tset aside ${String(aside)} rows`);
      if (describeOutcome(outcome) !== 'rows 1') wrong.push(`${line}\texpected rows 1`);
      if (before !== after) wrong.push(`${line}\tthe table changed`);
    }
    executed.push(...admitted);
    tally('0020 own insert', admitted);
    expect(wrong).toStrictEqual([]);
    expect(admitted).toHaveLength(inserting.length);
    expect(inserting.length).toBeGreaterThan(0);
  }, 120_000);

  it('calls every function as every caller, and only the granted two run', async () => {
    const wrong: string[] = [];
    for (const fn of functions) {
      for (const caller of [...TABLE_CALLERS, 'owner'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        const outcome = await callers.call(caller, callFor(fn));
        const application = caller !== 'owner' && APPLICATION_CALLERS.has(caller);
        const expected =
          caller === 'owner' || (application && APPLICATION_EXECUTES.includes(fn.qualified))
            ? fn.trigger
              ? 'trigger-only'
              : 'rows 1'
            : 'denied';
        const line = `${fn.signature}\tcall\t${caller}\t${describeOutcome(outcome)}`;
        executed.push(line);
        if (describeOutcome(outcome) !== expected) wrong.push(`${line}\texpected ${expected}`);
      }
    }
    expect(wrong).toStrictEqual([]);
  });

  describe('the security definer function', () => {
    const definers = (): readonly CatalogueFunction[] => functions.filter((fn) => fn.definer);

    it('is exactly one, a trigger on handback_reports with its search path pinned', () => {
      expect(definers().map((fn) => fn.signature)).toStrictEqual([
        'handback_reports_append_only()',
      ]);
      const [fn] = definers();
      expect(fn?.trigger).toBe(true);
      expect(fn?.config).toStrictEqual(['search_path=pg_catalog, public']);
      expect(fn?.firedBy).toStrictEqual([
        { table: 'public.handback_reports', events: 'delete update' },
      ]);
    });

    it('fires for the one role that may update or delete a report, and refuses it', async () => {
      // The permitted caller path. The application group was granted select
      // and insert only, so the owner is the only role whose update or delete
      // reaches the trigger at all, and the trigger refuses it.
      const table = 'public.handback_reports';
      const before = await fingerprint(world.db.admin, table);
      for (const text of [
        `update ${table} set business_id = business_id where business_id = $1 returning 1`,
        `delete from ${table} where business_id = $1 returning 1`,
      ]) {
        // oxlint-disable-next-line no-await-in-loop
        const outcome = await callers.call('owner', text, [world.alpha]);
        executed.push(`${table}\tdefiner via trigger\towner\t${describeOutcome(outcome)}`);
        expect(outcome.kind).toBe('raised');
        expect(outcome.kind === 'raised' ? outcome.message : '').toMatch(/append only/u);
      }
      expect(await fingerprint(world.db.admin, table)).toBe(before);
    });

    it('is never reached by an application caller, in its own tenant or another', async () => {
      const table = 'public.handback_reports';
      const before = await fingerprint(world.db.admin, table);
      for (const caller of [
        'login in the wrapper, own tenant',
        'login in the wrapper, other tenant',
        'login outside the wrapper',
      ] as const) {
        for (const text of [
          `update ${table} set business_id = business_id where business_id = $1 returning 1`,
          `delete from ${table} where business_id = $1 returning 1`,
        ]) {
          // oxlint-disable-next-line no-await-in-loop
          const outcome = await callers.call(caller, text, [world.alpha]);
          executed.push(`${table}\tdefiner via trigger\t${caller}\t${describeOutcome(outcome)}`);
          // Refused by privilege before any row is read, so the trigger, and
          // with it the definer's elevated rights, is never entered.
          expect(describeOutcome(outcome)).toBe('denied');
        }
      }
      expect(await fingerprint(world.db.admin, table)).toBe(before);
    });
  });
});
