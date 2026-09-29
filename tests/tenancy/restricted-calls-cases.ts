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

import { type AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';

export const WORKER_ROLE = 'ops_astro_worker';
/** The broker's role (AW-01): it executes the fair share's one count, and holds nothing else. */
export const BROKER_ROLE = 'ops_astro_broker';

/**
 * The contract: what 0001-0020 grant the application group, table by table,
 * as `s` select, `i` insert, `u` update, `d` delete. Read from the `grant`
 * lines of the migrations, not from the catalogue this suite then checks.
 */
const GRANT_GROUPS: readonly (readonly [string, string])[] = [
  ['', 'ops.schema_migrations'],
  ['s', 'ops.slots'],
  ['si', 'audit_events authentication_attempts evidence_packs gate_decisions'],
  ['si', 'alerts handback_reports operations run_events'],
  // AW-01: the model-call ledger, and the copy register, which is append only.
  ['siu', 'model_calls'],
  ['si', 'copy_registrations'],
  // AW-02: the pin and the read ledger are never rewritten; the audit copy is
  // kept and never read back by a run role.
  ['si', 'bootstrap_reads run_definition_pins'],
  ['i', 'bootstrap_bytes'],
  // AW-05: a budget ask is the persisted count and is never rewritten.
  ['si', 'budget_asks'],
  // AW-05: an answer and its approvals are never rewritten.
  ['si', 'budget_answers budget_approvals'],
  ['siu', 'actor_logins attempts budget_caps business_settings delegations gates grants'],
  ['siu', 'leases planned_steps proposal_lineages proposal_versions'],
  // AW-02: a historical run is never rewritten; the application moves its
  // state alone, by the column grant in COLUMN_UPDATES.
  ['si', 'planned_runs'],
  ['siu', 'outage_reports outage_runs reservations task_envelopes'],
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
  // 0043 takes back update on the whole run and grants it on `state` alone.
  'public.planned_runs': { from: '0043', letters: 'u' },
};

/**
 * Update granted column by column: the table, the columns, and the first
 * migration that grants them. Every other column-level privilege, to any
 * role, is outside the contract.
 */
const COLUMN_UPDATES: Readonly<
  Record<string, { readonly from: string; readonly columns: readonly string[] }>
> = {
  'public.planned_runs': { from: '0043', columns: ['state'] },
};

/** The `table.column` pairs the application group may update after `at`, or at the full schema. */
export function columnUpdatesAt(at?: string): readonly string[] {
  return Object.entries(COLUMN_UPDATES)
    .filter(([, grant]) => at === undefined || at.slice(0, 4) >= grant.from)
    .flatMap(([table, grant]) => grant.columns.map((column) => `${table}.${column}`))
    .toSorted();
}

/** Every column-level privilege on the cluster's schema, as `grantee PRIVILEGE table.column`. */
export async function catalogueColumnGrants(admin: AdminConnection): Promise<readonly string[]> {
  const rows = await admin.execute<{ line: string }>(
    `select pg_get_userbyid(acl.grantee) || ' ' || acl.privilege_type || ' ' ||
            n.nspname || '.' || c.relname || '.' || a.attname as line
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(a.attacl) acl
      where a.attacl is not null and n.nspname in ('public', 'ops')
      order by 1`,
  );
  return rows.map((row) => row.line);
}

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

export class Rollback extends Error {
  readonly rows: number;
  constructor(rows: number) {
    super('rolled back on purpose');
    this.rows = rows;
  }
}

export const asRole =
  (connection: AdminConnection, role?: string) =>
  async (text: string, parameters: readonly unknown[]): Promise<readonly unknown[]> =>
    await connection.transaction(async (execute) => {
      if (role !== undefined) await execute(`set local role ${role}`);
      return await execute(text, parameters);
    });
