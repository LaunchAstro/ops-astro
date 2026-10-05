// SPDX-License-Identifier: AGPL-3.0-only
//
// I06 and M02, the callers and the operations: every restricted caller, the
// statement each operation issues against a table or function, the fingerprint
// a committed refusal must leave unchanged, and the outcome the contract
// expects. Split from `restricted-calls-cases.ts` (the contract and the
// catalogue reads) so each stays under the per-file cap. Nothing here asserts.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  connect,
  connectAsAdmin,
  type AdminConnection,
  type Database,
} from '../../packages/core-records/src/tenancy/database.ts';
import { APPLICATION_ROLE, type EmptyDatabase } from '../support/fresh-database.ts';
import {
  WORKER_ROLE,
  applicationGrantsAt,
  type Outcome,
  classify,
  describeOutcome,
  Rollback,
  asRole,
} from './restricted-calls-cases.ts';
import {
  INSERT_COLUMNS,
  type CatalogueTable,
  type CatalogueFunction,
} from './restricted-calls-catalogue.ts';

/**
 * The callers. Every refusal position commits, so a write that should have
 * been refused and was not would land and the fingerprint would show it. Only
 * the own-tenant wrapper, the one caller allowed to write, is rolled back.
 */
export type CallerName =
  | 'login in the wrapper, own tenant'
  | 'login in the wrapper, other tenant'
  | 'login outside the wrapper'
  | 'application group outside the wrapper'
  | 'outsider in the wrapper'
  | 'outsider outside the wrapper'
  | 'worker'
  | 'owner';

export interface Callers {
  call(caller: CallerName, text: string, parameters?: readonly unknown[]): Promise<Outcome>;
  close(): Promise<void>;
}

/** A call's rows, or its refusal classified; a rolled-back write counts what it wrote. */
const counted = async (run: () => Promise<readonly unknown[]>): Promise<Outcome> => {
  try {
    return { kind: 'rows', n: (await run()).length };
  } catch (error) {
    if (error instanceof Rollback) return { kind: 'rows', n: error.rows };
    return classify(error);
  }
};

export function openCallers(
  db: EmptyDatabase,
  businesses: { readonly own: string; readonly other: string },
): Callers {
  const login: Database = db.app;
  const loginRaw = connectAsAdmin(db.appUrl, { source: 'runtime', max: 1 });
  const outsider = connect(db.restrictedUrl, { source: 'restricted', max: 1 });
  const outsiderRaw = connectAsAdmin(db.restrictedUrl, { source: 'restricted', max: 1 });

  const runners: Record<
    CallerName,
    (text: string, parameters: readonly unknown[]) => Promise<readonly unknown[]>
  > = {
    'login in the wrapper, own tenant': async (text, parameters) =>
      await login.withBusiness(businesses.own, async (tx) => {
        throw new Rollback((await tx.query(text, parameters)).length);
      }),
    'login in the wrapper, other tenant': async (text, parameters) =>
      await login.withBusiness(businesses.other, async (tx) => await tx.query(text, parameters)),
    'login outside the wrapper': asRole(loginRaw),
    'application group outside the wrapper': asRole(loginRaw, APPLICATION_ROLE),
    'outsider in the wrapper': async (text, parameters) =>
      await outsider.withBusiness(businesses.own, async (tx) => await tx.query(text, parameters)),
    'outsider outside the wrapper': asRole(outsiderRaw),
    worker: asRole(db.admin, WORKER_ROLE),
    owner: asRole(db.admin),
  };

  return {
    call: async (caller, text, parameters = []) =>
      await counted(async () => await runners[caller](text, parameters)),
    close: async () => {
      await Promise.all([loginRaw.close(), outsider.close(), outsiderRaw.close()]);
    },
  };
}

export type Operation = 'select' | 'insert' | 'update' | 'delete';
export const OPERATIONS: readonly Operation[] = ['select', 'insert', 'update', 'delete'];

/**
 * The statement for one operation. Tenant tables are aimed at the own
 * business's rows by `business_id`, so the other tenant and the unset wrapper
 * are asked for rows that exist and must see none. Every statement returns one
 * row per row it touched, so the count is the server's.
 */
export function statementFor(table: CatalogueTable, operation: Operation): string {
  const t = table.qualified;
  const where = table.tenant ? ' where business_id = $1' : '';
  const column = table.tenant ? 'business_id' : `"${table.firstColumn}"`;
  const statements: Readonly<Record<Operation, string>> = {
    select: `select 1 from ${t}${where}`,
    insert: table.tenant
      ? `insert into ${t} (business_id) values ($1) returning 1`
      : `insert into ${t} default values returning 1`,
    update: `update ${t} set ${column} = ${column}${where} returning 1`,
    delete: `delete from ${t}${where} returning 1`,
  };
  return statements[operation];
}

export const GRANT_LETTER: Readonly<Record<Operation, string>> = {
  select: 's',
  insert: 'i',
  update: 'u',
  delete: 'd',
};

/** The whole table as the owner sees it, which row security does not filter for a superuser. */
export async function fingerprint(admin: AdminConnection, table: string): Promise<string> {
  const rows = await admin.execute<{ h: string }>(
    `select count(*)::text || ':' ||
            md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h from ${table} t`,
  );
  return rows[0]?.h ?? '';
}

export async function ownRows(
  admin: AdminConnection,
  table: CatalogueTable,
  business: string,
): Promise<number> {
  const rows = await admin.execute<{ n: number }>(
    table.tenant
      ? `select count(*)::int as n from ${table.qualified} where business_id = $1`
      : `select count(*)::int as n from ${table.qualified}`,
    table.tenant ? [business] : [],
  );
  return rows[0]?.n ?? 0;
}

/** A direct call with a typed null per argument; the privilege check comes before the body. */
export const callFor = (fn: CatalogueFunction): string =>
  `select ${fn.qualified}(${fn.argumentTypes.map((type) => `null::${type}`).join(', ')})`;

/** Where the executed counts go: `.local/` is gitignored and the runner swallows stdout. */
export function tally(label: string, lines: readonly string[]): void {
  const file = process.env['RESTRICTED_CALLS_EVIDENCE'] ?? '.local/restricted-calls.tsv';
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, lines.map((line) => `${label}\t${line}\n`).join(''));
}

export const APPLICATION_CALLERS: ReadonlySet<CallerName> = new Set([
  'login in the wrapper, own tenant',
  'login in the wrapper, other tenant',
  'login outside the wrapper',
  'application group outside the wrapper',
]);

/**
 * What the contract says the server answers. `own` is how many rows the own
 * business holds in the table, counted by the owner.
 *
 * A role outside the application group is refused every table. The group is
 * refused what it was not granted, and within what it was granted the tenancy
 * policy decides: the own business sees and touches its own rows, and every
 * other position -- the other tenant, and the wrapper not entered at all --
 * sees none of them and may not write one.
 */
export function expectedOutcome(
  caller: CallerName,
  table: CatalogueTable,
  operation: Operation,
  own: number,
  at?: string,
  copy = false,
): string {
  if (!APPLICATION_CALLERS.has(caller)) return 'denied';
  const granted = applicationGrantsAt(table.qualified, at);
  if (granted === undefined) return `no contract for ${table.qualified}`;
  if (!granted.includes(GRANT_LETTER[operation])) return 'denied';
  // A write granted on an installation-wide table (0047's outbox, SL09's gate
  // tables) passes privilege and then meets the table's own constraints or
  // triggers: the permitted path.
  if (!table.tenant) return operation === 'select' ? `rows ${String(own)}` : 'past privilege';
  // The own tenant's writes pass privilege and tenancy and then meet the
  // table's own constraints or triggers; getting that far is the permitted path.
  if (caller === 'login in the wrapper, own tenant') {
    return operation === 'select' ? `rows ${String(own)}` : 'past tenancy';
  }
  if (operation === 'insert') return beforeRowRefusal(table.qualified, at, copy) ?? 'rls';
  return 'rows 0';
}

/**
 * Tables whose BEFORE ROW insert trigger answers before the tenancy WITH CHECK,
 * which Postgres evaluates after those triggers. The row still does not land,
 * as the fingerprint shows. `delegations_agent_is_an_agent` (0008) reads the
 * agent from `actors` as the caller, where the tenancy policy hides every other
 * business's actors, so it raises `check_violation` for a foreign business.
 */
export const BEFORE_ROW_REFUSALS: Readonly<Record<string, string>> = {
  'public.delegations': 'constraint',
};

/**
 * The same for the bare insert alone, from the migration that adds the
 * trigger on. 20261003001115 (MP-6-2) refuses a new step holding
 * `plan_record_written` false, so the bare insert, which names `business_id`
 * alone, meets `check_violation` first; the whole-row copy, re-sending a step
 * with no record stored, says true and meets the tenancy check.
 */
const BARE_INSERT_REFUSALS_FROM: Readonly<
  Record<string, { readonly from: string; readonly outcome: string }>
> = {
  'public.planned_steps': { from: '20261003001115', outcome: 'constraint' },
};

function beforeRowRefusal(qualified: string, at: string | undefined, copy: boolean) {
  const later = copy ? undefined : BARE_INSERT_REFUSALS_FROM[qualified];
  if (later !== undefined && (at === undefined || at >= later.from)) return later.outcome;
  return BEFORE_ROW_REFUSALS[qualified];
}

/**
 * Which own row a table's copy case re-sends, where any row would not do.
 * A version re-sent into a terminal lineage is refused by 0040 (T3a), which
 * is that migration's rule and not this suite's question, so the copy is a
 * version on a live lineage. A step re-sent with a record stored is refused
 * by 20261003001115's own-task check before the tenancy check, so the copy is
 * a step with no record; the key is read from the JSON, so a prefix before
 * that migration, without the column, runs the same text.
 */
const OWN_ROW_FILTERS: Readonly<Record<string, string>> = {
  'public.proposal_versions': `and exists (select 1 from public.proposal_lineages l
                                   where l.business_id = t.business_id and l.id = t.lineage_id
                                     and l.state = 'live')`,
  'public.planned_steps': `order by row_to_json(t)->>'plan_record_id' nulls first`,
};

/**
 * Why a copy row is not the one the expectation was written for, if it is not.
 * The planned_steps copy expects row security's answer only for a step with no
 * record stored; this says so plainly rather than as `expected rls`.
 */
export function copyRowFinding(table: CatalogueTable, row: string): string | undefined {
  if (table.qualified !== 'public.planned_steps') return undefined;
  const stored = (JSON.parse(row) as { plan_record_id?: string | null }).plan_record_id;
  return stored === undefined || stored === null
    ? undefined
    : `the copy re-sends a step with plan_record_id ${stored}; it must have none stored`;
}

/**
 * A whole row of the own business, re-sent as it stands. Unlike the bare
 * insert it satisfies every column constraint, so what refuses it from another
 * tenant is the tenancy check (or the trigger above), never a missing value.
 * A table inserted into by column (MP-14-10a) is re-sent in its granted columns,
 * unless `whole`: the owner putting a row back exactly.
 */
export const copyStatement = (table: CatalogueTable, whole = false): string => {
  const columns = whole ? '*' : (INSERT_COLUMNS[table.qualified]?.join(', ') ?? '*');
  return `insert into ${table.qualified}${columns === '*' ? '' : ` (${columns})`}
     select ${columns} from json_populate_record(null::${table.qualified}, $1::text::json)
     returning 1`;
};

export async function ownRowJson(
  admin: AdminConnection,
  table: CatalogueTable,
  business: string,
): Promise<string | undefined> {
  const rows = await admin.execute<{ j: string }>(
    `select row_to_json(t)::text as j from ${table.qualified} t where business_id = $1
       ${OWN_ROW_FILTERS[table.qualified] ?? ''} limit 1`,
    [business],
  );
  return rows[0]?.j;
}

/** Whether an answer meets the expectation `expectedOutcome` wrote. */
export function meets(expected: string, outcome: Outcome): boolean {
  if (expected === 'past tenancy' || expected === 'past privilege') {
    return outcome.kind !== 'denied' && outcome.kind !== 'rls' && outcome.kind !== 'other';
  }
  return describeOutcome(outcome) === expected;
}
