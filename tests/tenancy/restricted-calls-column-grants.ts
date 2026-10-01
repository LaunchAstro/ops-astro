// SPDX-License-Identifier: AGPL-3.0-only
//
// The column-grant contract's tables (AW-02's run state; SL13's column-granted
// updates and C31's custody select) and the catalogue read they are held
// against. A leaf: `restricted-calls-cases.ts` re-exports what reviewers' proofs
// import from it, and `restricted-calls-columns.ts` drives the calls.

import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';
import { APPLICATION_ROLE } from '../support/fresh-database.ts';

/** Privileges granted column by column: the table, the columns, and the first migration that grants them. */
interface ColumnGrant {
  readonly table: string;
  readonly from: string;
  readonly columns: readonly string[];
}

/**
 * Update granted column by column. A table may gain columns in a later
 * migration, so one table can have more than one line. Every other
 * column-level privilege, to any role, is outside the contract.
 */
const COLUMN_UPDATES: readonly ColumnGrant[] = [
  { table: 'public.planned_runs', from: '0192', columns: ['state'] },
  // MP-14-10a: a graduation row's revision; a mandate's revocation.
  { table: 'public.graduation_classes', from: '0254', columns: ['revision'] },
  {
    table: 'public.standing_mandates',
    from: '0254',
    columns: ['revision', 'revoked_at', 'revoked_by_actor_id'],
  },
  // C33: an activation's setting; C52-A: the adoption that stands.
  {
    table: 'public.activations',
    from: '0255',
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
  { table: 'public.activations', from: '0256', columns: ['approval_id'] },
  // C41-A: an onboarding and its steps move on.
  { table: 'public.onboarding_steps', from: '0257', columns: ['closed_at', 'failures', 'state'] },
  { table: 'public.onboardings', from: '0257', columns: ['revision', 'state', 'stopped_at'] },
];

/** Select granted column by column (C31: custody's select leaves out the sealed columns). */
const COLUMN_SELECTS: readonly ColumnGrant[] = [
  {
    table: 'public.custody_secrets',
    from: '0251',
    columns: [
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
    ],
  },
];

const grantedAt = (grants: readonly ColumnGrant[], at?: string): readonly string[] =>
  grants
    .filter((grant) => at === undefined || at.slice(0, 4) >= grant.from)
    .flatMap((grant) => grant.columns.map((column) => `${grant.table}.${column}`))
    .toSorted();

/** The `table.column` pairs the application group may update after `at`, or at the full schema. */
export function columnUpdatesAt(at?: string): readonly string[] {
  return grantedAt(COLUMN_UPDATES, at);
}

/** The application group's column-by-column selects after `at`, as the catalogue spells them. */
export function applicationSelectsAt(at?: string): readonly string[] {
  return grantedAt(COLUMN_SELECTS, at).map((pair) => `${APPLICATION_ROLE} SELECT ${pair}`);
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
