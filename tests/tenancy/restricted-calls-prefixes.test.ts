// SPDX-License-Identifier: AGPL-3.0-only
//
// I06 and M02 at every migration prefix: the same actual calls as
// `restricted-calls.test.ts`, made after each migration rather than only after
// the last.
//
// Every prefix is chosen, not a sample of them. Each is a state a
// deployment can stop in between two migrations, a prefix is cheap here, and
// choosing a subset would mean deciding in advance which migration cannot have
// opened anything, which is the question this suite exists to ask.
//
// The migrations are applied by the prefix harness, `proveEachPrefix`, one
// migration per call on one database, so the catalogue, composite-key and
// default-deny findings are the harness's own at each step and nothing of it is
// copied here. After each step the live calls run against whatever tables and
// functions exist at that moment.
//
// The seed is two businesses, written by the owner once `businesses` exists,
// and then one row per business in every other tenant table that exists at
// the prefix, so the tenancy filter is shown on rows and not on empty tables
// (TC:108). The rows are the acceptance world's own, one per table, taken once
// from a full-schema world and written by the owner with triggers and foreign
// keys off, since an intermediate prefix has no journey to write them; the
// tables the journey leaves empty get a row made here. They are removed
// again before the next migration, so no migration meets a row it did not
// expect. The worker role is created by 0008, but roles belong to
// the cluster rather than the database, so on a server where any database has
// reached 0008 it exists at every prefix and is called there; where it does
// not exist it is not called, and the tally says which.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../support/fresh-database.ts';
import { describePrefix, proveEachPrefix } from '../support/prefix-harness.ts';
import { readMigrations } from '../../packages/core-records/src/tenancy/migrate.ts';
import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';
import { createWorld } from '../acceptance/world.ts';
import {
  callModelOnTheJourney,
  walkTheJourney,
  walkTheOtherLineages,
} from '../acceptance/restart-harness.ts';
import {
  APPLICATION_EXECUTES,
  WORKER_ROLE,
  catalogueFunctions,
  catalogueTables,
  describeOutcome,
  type CatalogueTable,
} from './restricted-calls-cases.ts';
import {
  APPLICATION_CALLERS,
  OPERATIONS,
  callFor,
  copyStatement,
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
} from './restricted-calls-callers.ts';
import { columnUpdateFindings } from './restricted-calls-columns.ts';

const serverUrl = databaseUrlFromEnvironment();
const onDisk = readMigrations('migrations');

/** SHA-256 of the four bytes `seed`, so the audit copy's own check holds. */
const SEED_DIGEST = createHash('sha256').update('seed').digest('hex');

/** Rows for the tables the journey leaves empty; foreign keys are off when they are written. */
const UNREACHED: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  'public.person_identifiers': {
    person_id: randomUUID(),
    kind: 'email',
    value: 'restricted-calls-seed',
    observed_value: 'restricted-calls-seed',
    source_system: 'restricted_calls',
  },
  'public.person_merges': {
    surviving_person_id: randomUUID(),
    absorbed_person_id: randomUUID(),
    decided_by_actor_id: randomUUID(),
    evidence: 'restricted_calls seed',
  },
  'public.record_links': {
    link_type: 'restricted_calls',
    from_record_id: randomUUID(),
    to_record_id: randomUUID(),
  },
  // T3e2: the journey drops nothing.
  'public.outage_reports': { cause: 'worker_lost' },
  'public.outage_runs': {
    outage_id: randomUUID(),
    attempt_id: randomUUID(),
    run_id: randomUUID(),
    task_id: randomUUID(),
    reactivated: false,
  },
  'public.live_corrections': {
    party_id: randomUUID(),
    task_id: randomUUID(),
    requested_by_actor_id: randomUUID(),
    requested_by_person_id: randomUUID(),
    target_path: 'src/pages/about.md',
    word: 'friendly',
    replacement: 'welcoming',
    page_url: 'https://agency.example/about/',
    pre_image_digest: 'sha256:seed',
    base_revision: 'rev-1',
    seam: 'seam-seed',
    version_id: randomUUID(),
    version_digest: 'sha256:seed',
  },
  'public.live_correction_receipts': {
    correction_id: randomUUID(),
    lease_id: randomUUID(),
    fence: 1,
    step: 'publish',
    outcome: 'live',
    observations: {},
  },
  // The journey records no check (MP-6-1); the row is written with foreign
  // keys off, as every reference row is.
  // The journey revises no run's state (MP-6-2).
  'public.run_states': {
    run_id: randomUUID(),
    task_id: randomUUID(),
    version: 1,
    knowledge: [],
    unknowns: [],
    revised_by_actor_id: randomUUID(),
  },
  'public.run_checks': {
    task_id: randomUUID(),
    run_id: randomUUID(),
    version_id: randomUUID(),
    lease_id: randomUUID(),
    attempt_id: randomUUID(),
    actor_id: randomUUID(),
    fence: 1,
    name: 'restricted calls seed',
    outcome: 'passed',
  },
  // The journey holds no conversation (AW-03).
  'public.conversations': {
    owner_actor_id: randomUUID(),
    owner_person_id: randomUUID(),
    title: 'restricted calls seed',
  },
  'public.conversation_messages': {
    conversation_id: randomUUID(),
    role: 'person',
    author_actor_id: randomUUID(),
    body: 'restricted calls seed',
  },
  'public.conversation_wrap_ups': {
    conversation_id: randomUUID(),
    version: 1,
    written_by_operation: 'conversation.wrap_up',
    code_revision: 'seed',
    request_quotation: 'restricted calls seed',
    items: [{}, {}, {}, {}, {}, {}, {}],
    left_open: [],
    activity_through: new Date(),
  },
  // AW-02: nothing writes a pin before AW-04's plan accept.
  'public.run_definition_pins': {
    run_id: randomUUID(),
    ref_kind: 'bootstrap_file',
    path: 'skills/seed.md',
    content_digest: SEED_DIGEST,
    content_size: 4,
    read_at: '2026-09-30T00:00:00Z',
    manifest: [],
    manifest_digest: SEED_DIGEST,
    pinned_by_actor_id: randomUUID(),
  },
  'public.bootstrap_reads': {
    run_id: randomUUID(),
    sequence: 1,
    path: 'skills/seed.md',
    content_digest: SEED_DIGEST,
    content_size: 4,
    is_entry: true,
  },
  // AW-05: nothing raises an ask before a run reaches its ceiling.
  'public.budget_asks': {
    run_id: randomUUID(),
    reservation_id: randomUUID(),
    lease_id: randomUUID(),
    decision_id: randomUUID(),
    ask_number: 1,
    kind: 'stop',
    ceiling_minor: 400,
    spent_minor: 0,
    currency: 'AUD',
  },
  // AW-05: nothing answers a stop that was never raised.
  'public.budget_approvals': {
    ask_id: randomUUID(),
    run_id: randomUUID(),
    person_id: randomUUID(),
    actor_id: randomUUID(),
    amount_minor: 300,
    currency: 'AUD',
  },
  'public.budget_answers': {
    ask_id: randomUUID(),
    run_id: randomUUID(),
    kind: 'end',
    first_person_id: randomUUID(),
  },
  // AW-13: nothing starts the exporter on the journey.
  'public.trace_export_cursors': {},
  'public.trace_export_gaps': { code: 'target_unreachable', events: 1 },
  'public.bootstrap_bytes': {
    content_digest: SEED_DIGEST,
    content_size: 4,
    bytes: '\\x73656564',
  },
};

type Reference = ReadonlyMap<string, readonly Record<string, unknown>[]>;

/**
 * Own rows per tenant table but `businesses`, from a world walked through the
 * journey. Several per table, because an earlier prefix can carry a narrower
 * check than the full schema, and the first row that meets it is the one used.
 */
async function referenceRows(): Promise<Reference> {
  const world = await createWorld('rcpw');
  try {
    await walkTheOtherLineages(world);
    await callModelOnTheJourney(world, await walkTheJourney(world));
    const rows = new Map(Object.entries(UNREACHED).map(([name, row]) => [name, [row]]));
    for (const table of await catalogueTables(world.db.admin)) {
      if (!table.tenant || table.qualified === 'public.businesses') continue;
      // oxlint-disable-next-line no-await-in-loop
      const own = await world.db.admin.execute<{ j: string }>(
        `select row_to_json(t)::text as j from ${table.qualified} t
          where business_id = $1 order by 1 limit 20`,
        [world.alpha],
      );
      if (own.length > 0) {
        rows.set(
          table.qualified,
          own.map((row) => JSON.parse(row.j) as Record<string, unknown>),
        );
      }
    }
    return rows;
  } finally {
    await world.close();
  }
}

/** Runs `text` as the owner with triggers and foreign keys off, returning the row count. */
const asOwner = async (
  admin: AdminConnection,
  text: string,
  parameters: readonly unknown[],
): Promise<number> =>
  await admin.transaction(async (execute) => {
    await execute('set local session_replication_role = replica');
    return (await execute(text, parameters)).length;
  });

/**
 * Writes the reference row once per business into every tenant table at this
 * prefix but `businesses`, with the columns the table has here; the rest take
 * their defaults. Returns the tables it could not seed, with the reason.
 */
async function seedPrefix(
  admin: AdminConnection,
  tables: readonly CatalogueTable[],
  reference: Reference,
  businesses: readonly string[],
): Promise<readonly string[]> {
  const unseeded: string[] = [];
  for (const table of tables) {
    if (!table.tenant || table.qualified === 'public.businesses') continue;
    const rows = reference.get(table.qualified) ?? [];
    if (rows.length === 0) {
      unseeded.push(`${table.qualified}: no reference row`);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop
    const present = await admin.execute<{ name: string }>(
      `select attname as name from pg_attribute
        where attrelid = $1::regclass and attnum > 0 and not attisdropped
          and attgenerated = '' and attidentity <> 'a'`,
      [table.qualified],
    );
    const names = present.map((column) => column.name);
    for (const business of businesses) {
      let reason = '';
      for (const row of rows) {
        const columns = names
          .filter((name) => name in row || name === 'id' || name === 'business_id')
          .map((name) => `"${name}"`)
          .join(', ');
        const values = JSON.stringify({ ...row, business_id: business, id: randomUUID() });
        try {
          // oxlint-disable-next-line no-await-in-loop
          await asOwner(
            admin,
            `insert into ${table.qualified} (${columns})
               select ${columns} from json_populate_record(null::${table.qualified}, $1::text::json)`,
            [values],
          );
          reason = '';
          break;
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
        }
      }
      if (reason !== '') unseeded.push(`${table.qualified}: ${reason}`);
    }
  }
  return unseeded;
}

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
  let reference: Reference;
  const alpha = randomUUID();
  const bravo = randomUUID();
  const counts: string[] = [];

  beforeAll(async () => {
    reference = await referenceRows();
    db = await createEmptyDatabase({ part: 'rcp' });
    callers = openCallers(db, { own: alpha, other: bravo });
  }, 180_000);

  afterAll(async () => {
    tally('prefix counts', counts);
    await callers?.close();
    await db?.drop();
  });

  // Read from the directory, not counted here, so the next migration is covered
  // with no edit to this suite (docs/local/DATA.md, "A new migration extends the
  // proof by itself").
  it('reads every migration on disk, numbered from 0001 with no gap, and covers each below', () => {
    expect(onDisk.map((migration) => `${migration.version}.sql`)).toStrictEqual(
      readdirSync('migrations')
        .filter((name) => name.endsWith('.sql'))
        .toSorted(),
    );
    expect(onDisk.map((migration) => migration.version.slice(0, 4))).toStrictEqual(
      Array.from({ length: onDisk.length }, (_, i) => String(i + 1).padStart(4, '0')),
    );
  });

  for (const migration of onDisk) {
    it(`answers every caller as the contract says after ${migration.version}`, async () => {
      // The runner refuses while this database has other sessions, and the
      // callers hold some from the prefix before. Closed for the migration and
      // opened again on the new prefix.
      await callers.close();
      await db.closeSessions();
      // oxlint-disable-next-line no-await-in-loop
      const [proof] = await proveEachPrefix(db, [migration]);
      callers = openCallers(db, { own: alpha, other: bravo });
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
      const wrong: string[] = [...(await seedPrefix(db.admin, tables, reference, [alpha, bravo]))];
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
            const expected = expectedOutcome(caller, table, operation, own, migration.version);
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
          const expected = expectedOutcome(caller, table, 'insert', 0, migration.version);
          const line = `${table.qualified} insert copy ${caller}: ${describeOutcome(outcome)}`;
          if (!meets(expected, outcome)) wrong.push(`${line}, expected ${expected}`);
          if (before !== after) wrong.push(`${line}, the table changed`);
        }
      }

      wrong.push(
        ...(await columnUpdateFindings(db.admin, callers, activeCallers, alpha, migration.version)),
      );

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
          `tenant=${String(tables.filter((table) => table.tenant).length)}`,
          `populated=${String(populated)}`,
          `functions=${String(functions.length)}`,
          `definers=${String(functions.filter((fn) => fn.definer).length)}`,
          `callers=${String(activeCallers.length)}`,
          `worker=${workerExists ? 'called' : 'absent'}`,
          `calls=${String(calls)}`,
        ].join('\t'),
      );
      // The seed rows go before the next migration, which never saw them.
      for (const table of tables) {
        if (!table.tenant || table.qualified === 'public.businesses') continue;
        // oxlint-disable-next-line no-await-in-loop
        await asOwner(db.admin, `delete from ${table.qualified} where business_id = any($1)`, [
          [alpha, bravo],
        ]);
      }
      expect(wrong).toStrictEqual([]);
      // Every tenant table holds an own row, so no tenancy read was asked of nothing.
      expect(populated).toBe(tables.filter((table) => table.tenant).length);
      expect(tables.length).toBeGreaterThan(0);
    }, 60_000);
  }
});
