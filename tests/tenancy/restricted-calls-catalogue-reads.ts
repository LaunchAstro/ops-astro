// SPDX-License-Identifier: AGPL-3.0-only
//
// The migrated catalogue's tables and functions, read back for
// `restricted-calls-cases.ts`'s contract. Moved whole from
// `restricted-calls-catalogue.ts` to keep it under the line limit; the reads
// are unchanged, and that file re-exports them.

import { type AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';

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
