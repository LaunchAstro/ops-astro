// SPDX-License-Identifier: AGPL-3.0-only
//
// The migrated catalogue read back for `restricted-calls-cases.ts`'s contract:
// its tables, its functions and every column-level grant, with the column-grant
// contract those are held against. Moved whole from that file to keep it under
// the line limit; the contract and the catalogue reads are unchanged.

import { type AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';
import { OCCURRENCE_ROLE } from './restricted-calls-cases.ts';

/**
 * Update granted column by column: the table, the columns, and the first migration that
 * grants them. Every other column-level privilege, to any role, is outside the contract.
 */
const COLUMN_UPDATES: Readonly<
  Record<string, { readonly from: string; readonly columns: readonly string[] }>
> = {
  'public.planned_runs': { from: '0086', columns: ['state'] },
  // C33: an activation's setting, pin and switch, each change by a person.
  'public.activations': {
    from: '20261005003850',
    columns: [
      'changed_at',
      'changed_by_actor_id',
      'enabled',
      'event_kind',
      'every_minutes',
      'mode',
      'revision',
      'version_id',
    ],
  },
  'public.leases': { from: '20261004040200', columns: ['expires_at', 'released_at', 'state'] },
  // C41-A: an onboarding's state, stop and revision, a step's state, failures and close.
  'public.onboardings': { from: '20261005094805', columns: ['revision', 'state', 'stopped_at'] },
  'public.onboarding_steps': {
    from: '20261005094805',
    columns: ['closed_at', 'failures', 'state'],
  },
  // C60: a client's four privacy settings, by `client.set_privacy` alone.
  'public.clients': {
    from: '20261003000423',
    columns: ['handles_health', 'model_egress', 'model_providers', 'no_agent_edits'],
  },
};

/**
 * Whether the migration `at` (its version, `0086_bootstrap_pins` or
 * `20261005003850_automations`) is `from` or later. Every four-digit ID sorts
 * before every fourteen-digit timestamp, so both are padded to fourteen.
 */
const reached = (at: string, from: string): boolean =>
  (at.split('_', 1)[0] ?? at).padStart(14, '0') >= from.padStart(14, '0');

/** The `table.column` pairs the application group may update after `at`, or at the full schema. */
export function columnUpdatesAt(at?: string): readonly string[] {
  return Object.entries(COLUMN_UPDATES)
    .filter(([, grant]) => at === undefined || reached(at, grant.from))
    .flatMap(([table, grant]) => grant.columns.map((column) => `${table}.${column}`))
    .toSorted();
}

/**
 * Every other column grant, from the migration that made it: the occurrence role reads a
 * task's revision for 0032's trigger and stamps the live change record for 0035's
 * (AW-01 J, 0097), the application writes the outbox's
 * four columns alone (S0-2, 0047), and the lookup reads a business's id and key (G2, 0046).
 */
const ROLE_COLUMN_GRANTS: readonly { readonly from: string; readonly line: string }[] = [
  ...['business_id', 'id', 'revision'].map((column) => ({
    from: '0097',
    line: `${OCCURRENCE_ROLE} SELECT public.records.${column}`,
  })),
  // 0097: 0035's trigger on the occurrence's run upserts the task's stamp in
  // 0065's live change record, as the inserting role.
  ...[
    ['INSERT', 'business_id'],
    ['INSERT', 'subject_id'],
    ['INSERT', 'subject_kind'],
    ['SELECT', 'business_id'],
    ['SELECT', 'changed_xid'],
    ['SELECT', 'subject_id'],
    ['SELECT', 'subject_kind'],
    ['UPDATE', 'changed_at'],
    ['UPDATE', 'changed_xid'],
  ].map(([act, column]) => ({
    from: '0097',
    line: `${OCCURRENCE_ROLE} ${act} public.live_changes.${column}`,
  })),
  ...['event', 'kind', 'scope', 'weight'].map((column) => ({
    from: '0047',
    line: `ops_astro_app INSERT ops.api_events.${column}`,
  })),
  { from: '0046', line: 'ops_astro_lookup SELECT public.businesses.id' },
  { from: '0046', line: 'ops_astro_lookup SELECT public.businesses.key' },
  // S0-5 (0059): the gate's installation mode, alone (no business column).
  { from: '0059', line: 'ops_astro_app UPDATE ops.installation.mode' },
  // Batch 2a's provider-step queues (C58, C59): the application inserts and
  // reads them column by column.
  ...['INSERT', 'SELECT'].map((act) => ({
    from: '0061',
    line: `ops_astro_app ${act} ops.ended_provider_sessions.session_id`,
  })),
  ...[
    ['INSERT', 'kept_session'],
    ['INSERT', 'subject_digest'],
    ['SELECT', 'ended_before'],
    ['SELECT', 'kept_session'],
    ['SELECT', 'subject_digest'],
  ].map(([act, column]) => ({
    from: '0063',
    line: `ops_astro_app ${act} ops.ended_subject_sessions.${column}`,
  })),
  ...['INSERT', 'SELECT'].flatMap((act) =>
    ['factor_digest', 'state', 'subject_digest'].map((column) => ({
      from: '0064',
      line: `ops_astro_app ${act} ops.second_factor_subjects.${column}`,
    })),
  ),
  // Batch 2b's (C55, C59): the forwarder writes an alert's kind alone and the
  // application reads kind and time (0069); a second-factor code's rows are
  // read and written column by column (0072).
  { from: '0069', line: 'ops_astro_forwarder INSERT ops.security_alert_log.kind' },
  ...['at', 'kind'].map((column) => ({
    from: '0069',
    line: `ops_astro_app SELECT ops.security_alert_log.${column}`,
  })),
  ...[
    ['INSERT', 'attempt'],
    ['INSERT', 'state'],
    ['INSERT', 'subject_digest'],
    ['SELECT', 'attempt'],
    ['SELECT', 'recorded_at'],
    ['SELECT', 'state'],
    ['SELECT', 'subject_digest'],
  ].map(([act, column]) => ({
    from: '0072',
    line: `ops_astro_app ${act} ops.second_factor_codes.${column}`,
  })),
  // C31: custody's select leaves out the three sealed columns (20261005023013).
  ...[
    'business_id',
    'cleared_at',
    'cleared_by_actor_id',
    'created_at',
    'id',
    'key_id',
    'last_used_at',
    'name',
    'revision',
    'scope_id',
    'scope_kind',
    'set_at',
    'set_by_actor_id',
  ].map((column) => ({
    from: '20261005023013',
    line: `ops_astro_app SELECT public.custody_secrets.${column}`,
  })),
];

export function roleColumnGrantsAt(at?: string): readonly string[] {
  return ROLE_COLUMN_GRANTS.filter((grant) => at === undefined || reached(at, grant.from))
    .map((grant) => grant.line)
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
