// SPDX-License-Identifier: AGPL-3.0-only
//
// The column grants (AW-02: planned_runs moves its state alone) held against
// the contract, and an actual update of each granted column by every caller.
// Beside `restricted-calls-callers.ts`, whose callers it drives.

import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';
import { APPLICATION_ROLE } from '../support/fresh-database.ts';
import { OCCURRENCE_ROLE, describeOutcome } from './restricted-calls-cases.ts';
import {
  APPLICATION_CALLERS,
  fingerprint,
  type CallerName,
  type Callers,
} from './restricted-calls-callers.ts';

/**
 * Update granted column by column: the table, the columns, and the first migration that
 * grants them. Every other column-level privilege, to any role, is outside the contract.
 */
const COLUMN_UPDATES: Readonly<
  Record<string, { readonly from: string; readonly columns: readonly string[] }>
> = {
  'public.planned_runs': { from: '0192', columns: ['state'] },
  'public.invitations': { from: '0222', columns: ['ended_at', 'expires_at', 'revision', 'state'] },
  'public.enrolment_tokens': { from: '0222', columns: ['spent_at'] },
};

/** The `table.column` pairs the application group may update after `at`, or at the full schema. */
export function columnUpdatesAt(at?: string): readonly string[] {
  return Object.entries(COLUMN_UPDATES)
    .filter(([, grant]) => at === undefined || at.slice(0, 4) >= grant.from)
    .flatMap(([table, grant]) => grant.columns.map((column) => `${table}.${column}`))
    .toSorted();
}

const FACTOR = ['subject_digest', 'factor_digest', 'state'];

/** The application's column grants on one table: `select (...)`, then `insert (...)`. */
function grantsOn(
  from: string,
  table: string,
  select: readonly string[],
  insert: readonly string[],
): { readonly from: string; readonly line: string }[] {
  return [
    ...select.map((column) => ({ from, line: `ops_astro_app SELECT ${table}.${column}` })),
    ...insert.map((column) => ({ from, line: `ops_astro_app INSERT ${table}.${column}` })),
  ];
}

/**
 * Every other column grant, from the migration that made it: the occurrence role reads a
 * task's revision for 0032's trigger (AW-01 J, 0203), the application writes the outbox's
 * four columns alone (S0-2, 0047), and the lookup reads a business's id and key (G2, 0046).
 * Main's installation-wide tables, granted by column: the gate moves the installation's
 * mode (S0-5, 0059), ended sessions (C58, 0061, 0063), second factors and their codes
 * (C59, 0064, 0072), the forwarder's alert log (C55, 0069) and reset mail (C40, 0225).
 */
const ROLE_COLUMN_GRANTS: readonly { readonly from: string; readonly line: string }[] = [
  { from: '0059', line: 'ops_astro_app UPDATE ops.installation.mode' },
  ...grantsOn('0061', 'ops.ended_provider_sessions', ['session_id'], ['session_id']),
  ...grantsOn(
    '0063',
    'ops.ended_subject_sessions',
    ['subject_digest', 'kept_session', 'ended_before'],
    ['subject_digest', 'kept_session'],
  ),
  ...grantsOn('0064', 'ops.second_factor_subjects', FACTOR, FACTOR),
  { from: '0069', line: 'ops_astro_forwarder INSERT ops.security_alert_log.kind' },
  ...grantsOn('0069', 'ops.security_alert_log', ['kind', 'at'], []),
  ...grantsOn(
    '0072',
    'ops.second_factor_codes',
    ['subject_digest', 'attempt', 'state', 'recorded_at'],
    ['subject_digest', 'attempt', 'state'],
  ),
  ...grantsOn(
    '0225',
    'ops.password_reset_attempts',
    ['subject_digest', 'address_digest', 'attempt', 'state', 'evidence', 'recorded_at'],
    ['subject_digest', 'address_digest', 'attempt', 'state', 'evidence'],
  ),
  ...['business_id', 'id', 'revision'].map((column) => ({
    from: '0203',
    line: `${OCCURRENCE_ROLE} SELECT public.records.${column}`,
  })),
  ...['event', 'kind', 'scope', 'weight'].map((column) => ({
    from: '0047',
    line: `ops_astro_app INSERT ops.api_events.${column}`,
  })),
  { from: '0046', line: 'ops_astro_lookup SELECT public.businesses.id' },
  { from: '0046', line: 'ops_astro_lookup SELECT public.businesses.key' },
];

export function roleColumnGrantsAt(at?: string): readonly string[] {
  return ROLE_COLUMN_GRANTS.filter((grant) => at === undefined || at.slice(0, 4) >= grant.from)
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

/**
 * The column grants held against the contract, then an actual update of each
 * granted column by every caller: the own business moves its own rows, every
 * other application position touches none, and every other role is refused.
 * Returns what is wrong, one line each; an empty list is the contract met.
 */
export async function columnUpdateFindings(
  admin: AdminConnection,
  callers: Callers,
  active: readonly CallerName[],
  business: string,
  at?: string,
): Promise<string[]> {
  const pairs = columnUpdatesAt(at);
  const held = await catalogueColumnGrants(admin);
  const wanted = [
    ...pairs.map((pair) => `${APPLICATION_ROLE} UPDATE ${pair}`),
    ...roleColumnGrantsAt(at),
  ].toSorted();
  const wrong = held.join(', ') === wanted.join(', ') ? [] : [`column grants: ${held.join(', ')}`];
  for (const pair of pairs) {
    // One table at a time: the callers share their connections.
    // oxlint-disable-next-line no-await-in-loop
    wrong.push(...(await columnCalls(admin, callers, active, business, pair)));
  }
  return wrong;
}

/** A column update's answer: the own business its own rows, other application positions none. */
function columnExpected(caller: CallerName, own: string): string {
  if (!APPLICATION_CALLERS.has(caller)) return 'denied';
  return caller === 'login in the wrapper, own tenant' ? own : 'rows 0';
}

async function columnCalls(
  admin: AdminConnection,
  callers: Callers,
  active: readonly CallerName[],
  business: string,
  pair: string,
): Promise<string[]> {
  const table = pair.slice(0, pair.lastIndexOf('.'));
  const column = pair.slice(pair.lastIndexOf('.') + 1);
  const text = `update ${table} set "${column}" = "${column}" where business_id = $1 returning 1`;
  const [ownCount] = await admin.execute<{ n: number }>(
    `select count(*)::int as n from ${table} where business_id = $1`,
    [business],
  );
  const own = `rows ${String(ownCount?.n ?? 0)}`;
  const wrong: string[] = [];
  for (const caller of active) {
    // One statement at a time, each read against the state the last one left.
    // oxlint-disable-next-line no-await-in-loop
    const before = await fingerprint(admin, table);
    // oxlint-disable-next-line no-await-in-loop
    const outcome = describeOutcome(await callers.call(caller, text, [business]));
    // oxlint-disable-next-line no-await-in-loop
    const after = await fingerprint(admin, table);
    const expected = columnExpected(caller, own);
    const line = `${pair} update ${caller}: ${outcome}`;
    if (outcome !== expected) wrong.push(`${line}, expected ${expected}`);
    if (before !== after) wrong.push(`${line}, the table changed`);
  }
  return wrong;
}
