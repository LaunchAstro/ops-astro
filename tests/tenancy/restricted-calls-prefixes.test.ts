// SPDX-License-Identifier: AGPL-3.0-only
//
// I06 and M02 at every migration prefix: the same actual calls as
// `restricted-calls.test.ts`, made after each migration rather than only after
// the last.
//
// Every prefix is chosen, not a sample of them. Each is a state an
// installation can stop in between two migrations, a prefix is cheap here, and
// choosing a subset would mean deciding in advance which migration cannot have
// opened anything, which is the question this suite exists to ask.
//
// The migrations are applied by the prefix harness, `proveEachPrefix`, one
// migration per call on one database, so the catalogue, composite-key and
// default-deny findings are the harness's own at each step and nothing of it is
// copied here. After each step the live calls run against whatever tables and
// functions exist at that moment.
//
// The seed is two businesses, written by the owner once `businesses` exists.
// Every later table is empty at its prefix, so the tenancy filter is shown on
// rows only for `businesses` here; the populated proof of the rest is the
// full-schema suite. The worker role is created by 0008, but roles belong to
// the cluster rather than the database, so on a server where any database has
// reached 0008 it exists at every prefix and is called there; where it does
// not exist it is not called, and the tally says which.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  describePrefix,
  proveEachPrefix,
} from '../../packages/core-records/src/tenancy/testing/prefix-harness.ts';
import { readMigrations } from '../../packages/core-records/src/tenancy/migrate.ts';
import {
  APPLICATION_CALLERS,
  APPLICATION_EXECUTES,
  OPERATIONS,
  WORKER_ROLE,
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
  type Callers,
} from './restricted-calls-cases.ts';

const serverUrl = databaseUrlFromEnvironment();
const onDisk = readMigrations('migrations');

const CALLERS: readonly CallerName[] = [
  'login in the wrapper, own tenant',
  'login in the wrapper, other tenant',
  'login outside the wrapper',
  'application group outside the wrapper',
  'outsider in the wrapper',
  'outsider outside the wrapper',
  'worker',
];

describe.skipIf(serverUrl === undefined)('I06/M02: restricted calls at every prefix', () => {
  let db: EmptyDatabase;
  let callers: Callers;
  const alpha = randomUUID();
  const bravo = randomUUID();
  const counts: string[] = [];

  beforeAll(async () => {
    db = await createEmptyDatabase({ part: 'rcp' });
    callers = openCallers(db, { own: alpha, other: bravo });
  }, 60_000);

  afterAll(async () => {
    tally('prefix counts', counts);
    await callers?.close();
    await db?.drop();
  });

  it('has twenty-three migrations on disk, 0001 to 0023, and covers each below', () => {
    expect(onDisk.map((migration) => migration.version.slice(0, 4))).toStrictEqual(
      Array.from({ length: 23 }, (_, i) => String(i + 1).padStart(4, '0')),
    );
  });

  for (const migration of onDisk) {
    it(`answers every caller as the contract says after ${migration.version}`, async () => {
      // oxlint-disable-next-line no-await-in-loop
      const [proof] = await proveEachPrefix(db, [migration]);
      expect(proof?.version).toBe(migration.version);
      if (proof !== undefined && proof.findings.length > 0) expect(describePrefix(proof)).toBe('');
      if (migration.version.startsWith('0001')) {
        for (const id of [alpha, bravo]) {
          // oxlint-disable-next-line no-await-in-loop
          await db.admin.execute(
            `insert into public.businesses (business_id, id, key, name) values ($1, $1, $2, $2)`,
            [id, `b${id.slice(0, 8)}`],
          );
        }
      }

      // Roles belong to the cluster; the full-schema suite classifies all of them.
      const workerExists =
        (await db.admin.execute('select 1 from pg_roles where rolname = $1', [WORKER_ROLE]))
          .length === 1;
      const activeCallers = CALLERS.filter((caller) => caller !== 'worker' || workerExists);

      const tables = await catalogueTables(db.admin);
      const functions = await catalogueFunctions(db.admin);
      const wrong: string[] = [];
      let calls = 0;
      let populated = 0;

      for (const table of tables) {
        // oxlint-disable-next-line no-await-in-loop
        const own = await ownRows(db.admin, table, alpha);
        if (table.tenant && own > 0) populated += 1;
        for (const operation of OPERATIONS) {
          const text = statementFor(table, operation);
          for (const caller of activeCallers) {
            // oxlint-disable-next-line no-await-in-loop
            const before = await fingerprint(db.admin, table.qualified);
            // oxlint-disable-next-line no-await-in-loop
            const outcome = await callers.call(caller, text, table.tenant ? [alpha] : []);
            // oxlint-disable-next-line no-await-in-loop
            const after = await fingerprint(db.admin, table.qualified);
            calls += 1;
            const expected = expectedOutcome(caller, table, operation, own);
            const line = `${table.qualified} ${operation} ${caller}: ${describeOutcome(outcome)}`;
            if (!meets(expected, outcome)) wrong.push(`${line}, expected ${expected}`);
            if (before !== after) wrong.push(`${line}, the table changed`);
          }
        }
        // oxlint-disable-next-line no-await-in-loop
        const row = table.tenant ? await ownRowJson(db.admin, table, alpha) : undefined;
        if (row === undefined) continue;
        for (const caller of activeCallers.slice(1)) {
          // oxlint-disable-next-line no-await-in-loop
          const before = await fingerprint(db.admin, table.qualified);
          // oxlint-disable-next-line no-await-in-loop
          const outcome = await callers.call(caller, copyStatement(table), [row]);
          // oxlint-disable-next-line no-await-in-loop
          const after = await fingerprint(db.admin, table.qualified);
          calls += 1;
          const expected = expectedOutcome(caller, table, 'insert', 0);
          const line = `${table.qualified} insert copy ${caller}: ${describeOutcome(outcome)}`;
          if (!meets(expected, outcome)) wrong.push(`${line}, expected ${expected}`);
          if (before !== after) wrong.push(`${line}, the table changed`);
        }
      }

      for (const fn of functions) {
        for (const caller of [...activeCallers, 'owner'] as const) {
          // oxlint-disable-next-line no-await-in-loop
          const outcome = await callers.call(caller, callFor(fn));
          calls += 1;
          const runs =
            caller === 'owner' ||
            (APPLICATION_CALLERS.has(caller) && APPLICATION_EXECUTES.includes(fn.qualified));
          const expected = runs ? (fn.trigger ? 'trigger-only' : 'rows 1') : 'denied';
          if (describeOutcome(outcome) !== expected) {
            wrong.push(
              `${fn.signature} call ${caller}: ${describeOutcome(outcome)}, expected ${expected}`,
            );
          }
        }
      }

      counts.push(
        [
          migration.version,
          `tables=${String(tables.length)}`,
          `populated=${String(populated)}`,
          `functions=${String(functions.length)}`,
          `definers=${String(functions.filter((fn) => fn.definer).length)}`,
          `callers=${String(activeCallers.length)}`,
          `worker=${workerExists ? 'called' : 'absent'}`,
          `calls=${String(calls)}`,
        ].join('\t'),
      );
      expect(wrong).toStrictEqual([]);
      expect(tables.length).toBeGreaterThan(0);
    }, 60_000);
  }
});
