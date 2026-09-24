// SPDX-License-Identifier: AGPL-3.0-only
//
// I06 and M02: the machinery for an actual call by every restricted role
// against every table and function the migrations leave behind. A catalogue
// assertion says what a role was granted; this issues the statement and
// classifies the server's reply by SQLSTATE and message, because a policy, a
// trigger or a schema privilege sits between a grant and an answer.
//
// Only the contract is listed by hand: what the application group was granted.
// Tables, functions and roles are read from the migrated catalogue at call
// time, so a new table is covered without anybody extending a list, and one the
// contract does not name fails rather than being skipped. Nothing here asserts.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  connect,
  connectAsAdmin,
  type AdminConnection,
  type Database,
} from '../../packages/core-records/src/tenancy/database.ts';
import {
  APPLICATION_ROLE,
  type EmptyDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';

export const WORKER_ROLE = 'ops_astro_worker';

/**
 * The contract: what 0001-0020 grant the application group, table by table,
 * as `s` select, `i` insert, `u` update, `d` delete. Read from the `grant`
 * lines of the migrations, not from the catalogue this suite then checks.
 */
const GRANT_GROUPS: readonly (readonly [string, string])[] = [
  ['', 'ops.schema_migrations'],
  ['s', 'ops.slots'],
  ['si', 'audit_events authentication_attempts evidence_packs gate_decisions'],
  ['si', 'handback_reports operations'],
  ['siu', 'actor_logins attempts budget_caps business_settings delegations gates grants'],
  ['siu', 'leases planned_runs planned_steps proposal_lineages proposal_versions'],
  ['siu', 'reservations task_envelopes'],
  ['siud', 'actors businesses field_defs logins memberships people person_identifiers'],
  // 0028 revokes delete on these two: identity history is kept (0002).
  ['siu', 'person_logins person_merges'],
  ['siud', 'record_links record_types record_unique_values'],
  ['siud', 'records'],
];

export const APPLICATION_GRANTS: Readonly<Record<string, string>> = Object.fromEntries(
  GRANT_GROUPS.flatMap(([granted, names]) =>
    names.split(' ').map((name) => [name.includes('.') ? name : `public.${name}`, granted]),
  ),
);

/**
 * Grants a later migration took back, so a prefix before it still holds them.
 * Keyed by table; the version is the first migration that no longer grants the
 * letters. 0028 revokes delete on identity history (R1-AUTHORITY-55).
 */
const REVOKED: Readonly<Record<string, { readonly from: string; readonly letters: string }>> = {
  'public.person_logins': { from: '0028', letters: 'd' },
  'public.person_merges': { from: '0028', letters: 'd' },
};

/**
 * What the application group holds on a table after the migration `at` (its
 * version, `0001_tenancy` and so on), or at the full schema when `at` is absent.
 */
export function applicationGrantsAt(qualified: string, at?: string): string | undefined {
  const granted = APPLICATION_GRANTS[qualified];
  const revoked = REVOKED[qualified];
  if (granted === undefined || revoked === undefined || at === undefined) return granted;
  return at.slice(0, 4) < revoked.from ? granted + revoked.letters : granted;
}

/** The functions the application group may execute. Every other one is refused to it. */
export const APPLICATION_EXECUTES: readonly string[] = [
  'public.app_business_id',
  'public.audit_event_hash',
];

export interface CatalogueTable {
  readonly qualified: string;
  readonly kind: string;
  /** Carries `business_id`, so the tenancy policy is what filters it. */
  readonly tenant: boolean;
  readonly forced: boolean;
  readonly firstColumn: string;
}

export interface CatalogueFunction {
  readonly qualified: string;
  readonly signature: string;
  readonly argumentTypes: readonly string[];
  readonly definer: boolean;
  readonly trigger: boolean;
  readonly config: readonly string[];
  /** For a trigger function: the tables whose triggers fire it, with the events. */
  readonly firedBy: readonly { readonly table: string; readonly events: string }[];
}

export async function catalogueTables(admin: AdminConnection): Promise<readonly CatalogueTable[]> {
  const rows = await admin.execute<{
    qualified: string;
    kind: string;
    tenant: boolean;
    forced: boolean;
    first_column: string;
  }>(
    `select n.nspname || '.' || c.relname as qualified, c.relkind::text as kind,
            exists (select 1 from pg_attribute a where a.attrelid = c.oid
                     and a.attname = 'business_id' and not a.attisdropped) as tenant,
            c.relforcerowsecurity as forced,
            (select a.attname from pg_attribute a where a.attrelid = c.oid and a.attnum > 0
                and not a.attisdropped order by a.attnum limit 1) as first_column
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'ops') and c.relkind in ('r', 'v', 'm', 'p')
      order by 1`,
  );
  return rows.map((row) => ({
    qualified: row.qualified,
    kind: row.kind,
    tenant: row.tenant,
    forced: row.forced,
    firstColumn: row.first_column,
  }));
}

export async function catalogueFunctions(
  admin: AdminConnection,
): Promise<readonly CatalogueFunction[]> {
  const rows = await admin.execute<{
    qualified: string;
    signature: string;
    argument_types: string[];
    definer: boolean;
    trigger: boolean;
    config: string[] | null;
    fired_by: { table: string; events: string }[] | null;
  }>(
    `select n.nspname || '.' || p.proname as qualified, p.oid::regprocedure::text as signature,
            coalesce((select array_agg(format_type(t, null) order by i)
                        from unnest(p.proargtypes) with ordinality as a(t, i)), '{}') as argument_types,
            p.prosecdef as definer, p.prorettype = 'trigger'::regtype as trigger, p.proconfig as config,
            (select json_agg(json_build_object(
                      'table', tn.nspname || '.' || tc.relname,
                      'events', concat_ws(' ',
                        case when t.tgtype & 4 <> 0 then 'insert' end,
                        case when t.tgtype & 8 <> 0 then 'delete' end,
                        case when t.tgtype & 16 <> 0 then 'update' end)))
               from pg_trigger t join pg_class tc on tc.oid = t.tgrelid
               join pg_namespace tn on tn.oid = tc.relnamespace
              where t.tgfoid = p.oid and not t.tgisinternal) as fired_by
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'ops') and p.prokind = 'f'
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      order by 2`,
  );
  return rows.map((row) => ({
    qualified: row.qualified,
    signature: row.signature,
    argumentTypes: row.argument_types,
    definer: row.definer,
    trigger: row.trigger,
    config: row.config ?? [],
    firedBy: row.fired_by ?? [],
  }));
}

/** What the server said, reduced to what a contract can name. */
export type Outcome =
  | { readonly kind: 'rows'; readonly n: number }
  | { readonly kind: 'denied' }
  | { readonly kind: 'rls' }
  | { readonly kind: 'constraint' }
  | { readonly kind: 'raised'; readonly message: string }
  | { readonly kind: 'trigger-only' }
  | { readonly kind: 'other'; readonly code: string; readonly message: string };

export function classify(error: unknown): Outcome {
  const code = String((error as { code?: unknown }).code ?? '');
  const message = error instanceof Error ? error.message : String(error);
  if (code === '42501' && /row-level security/u.test(message)) return { kind: 'rls' };
  if (code === '42501' && /permission denied/u.test(message)) return { kind: 'denied' };
  if (code.startsWith('23')) return { kind: 'constraint' };
  if (code === 'P0001') return { kind: 'raised', message };
  if (code === '0A000' && /only be called as triggers/u.test(message)) {
    return { kind: 'trigger-only' };
  }
  return { kind: 'other', code, message };
}

export const describeOutcome = (outcome: Outcome): string =>
  outcome.kind === 'rows'
    ? `rows ${String(outcome.n)}`
    : outcome.kind === 'other'
      ? `other ${outcome.code} ${outcome.message}`
      : outcome.kind;

class Rollback extends Error {
  readonly rows: number;
  constructor(rows: number) {
    super('rolled back on purpose');
    this.rows = rows;
  }
}

const asRole =
  (connection: AdminConnection, role?: string) =>
  async (text: string, parameters: readonly unknown[]): Promise<readonly unknown[]> =>
    await connection.transaction(async (execute) => {
      if (role !== undefined) await execute(`set local role ${role}`);
      return await execute(text, parameters);
    });

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

export function openCallers(
  db: EmptyDatabase,
  businesses: { readonly own: string; readonly other: string },
): Callers {
  const login: Database = db.app;
  const loginRaw = connectAsAdmin(db.appUrl, { source: 'runtime', max: 1 });
  const outsider = connect(db.restrictedUrl, { source: 'restricted', max: 1 });
  const outsiderRaw = connectAsAdmin(db.restrictedUrl, { source: 'restricted', max: 1 });

  const counted = async (run: () => Promise<readonly unknown[]>): Promise<Outcome> => {
    try {
      return { kind: 'rows', n: (await run()).length };
    } catch (error) {
      if (error instanceof Rollback) return { kind: 'rows', n: error.rows };
      return classify(error);
    }
  };

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
): string {
  if (!APPLICATION_CALLERS.has(caller)) return 'denied';
  const granted = applicationGrantsAt(table.qualified, at);
  if (granted === undefined) return `no contract for ${table.qualified}`;
  if (!granted.includes(GRANT_LETTER[operation])) return 'denied';
  if (!table.tenant) return operation === 'select' ? `rows ${String(own)}` : 'no case';
  // The own tenant's writes pass privilege and tenancy and then meet the
  // table's own constraints or triggers; getting that far is the permitted path.
  if (caller === 'login in the wrapper, own tenant') {
    return operation === 'select' ? `rows ${String(own)}` : 'past tenancy';
  }
  if (operation === 'insert') return BEFORE_ROW_REFUSALS[table.qualified] ?? 'rls';
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
 * A whole row of the own business, re-sent as it stands. Unlike the bare
 * insert it satisfies every column constraint, so what refuses it from another
 * tenant is the tenancy check (or the trigger above), never a missing value.
 */
export const copyStatement = (table: CatalogueTable): string =>
  `insert into ${table.qualified}
     select * from json_populate_record(null::${table.qualified}, $1::text::json) returning 1`;

export async function ownRowJson(
  admin: AdminConnection,
  table: CatalogueTable,
  business: string,
): Promise<string | undefined> {
  const rows = await admin.execute<{ j: string }>(
    `select row_to_json(t)::text as j from ${table.qualified} t where business_id = $1 limit 1`,
    [business],
  );
  return rows[0]?.j;
}

/** Whether an answer meets the expectation `expectedOutcome` wrote. */
export function meets(expected: string, outcome: Outcome): boolean {
  if (expected === 'past tenancy') {
    return outcome.kind !== 'denied' && outcome.kind !== 'rls' && outcome.kind !== 'other';
  }
  return describeOutcome(outcome) === expected;
}
