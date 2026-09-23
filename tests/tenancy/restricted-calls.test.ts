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
} from './restricted-calls-cases.ts';

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
    callers = openCallers(world.db, { own: world.alpha, other: world.bravo });
    tables = await catalogueTables(world.db.admin);
    functions = await catalogueFunctions(world.db.admin);
  }, 180_000);

  afterAll(async () => {
    tally('0020 full', executed);
    await callers?.close();
    await world?.close();
  });

  it('reads twenty migrations, and a table set the contract names exactly', async () => {
    const applied = await world.db.admin.execute<{ version: string }>(
      'select version from ops.schema_migrations order by version',
    );
    expect(applied.map((row) => row.version.slice(0, 4))).toStrictEqual(
      Array.from({ length: 20 }, (_, i) => String(i + 1).padStart(4, '0')),
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
  });

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
