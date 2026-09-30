// SPDX-License-Identifier: AGPL-3.0-only
//
// The column grants (AW-02: planned_runs moves its state alone; C31's custody
// select; the SL13 tables' updates) held against the contract, and an actual
// update of each granted column by every caller.
// Beside `restricted-calls-callers.ts`, whose callers it drives.

import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';
import { APPLICATION_ROLE } from '../support/fresh-database.ts';
import {
  catalogueColumnGrants,
  describeOutcome,
  roleColumnGrantsAt,
} from './restricted-calls-cases.ts';
import {
  APPLICATION_CALLERS,
  fingerprint,
  type CallerName,
  type Callers,
} from './restricted-calls-callers.ts';

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
  { table: 'public.planned_runs', from: '0043', columns: ['state'] },
  // MP-14-10a: a graduation row's revision; a mandate's revocation.
  { table: 'public.graduation_classes', from: '0056', columns: ['revision'] },
  {
    table: 'public.standing_mandates',
    from: '0056',
    columns: ['revision', 'revoked_at', 'revoked_by_actor_id'],
  },
  // C33: an activation's setting; C52-A: the adoption that stands.
  {
    table: 'public.activations',
    from: '0057',
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
  { table: 'public.activations', from: '0058', columns: ['approval_id'] },
  // C41-A: an onboarding and its steps move on.
  { table: 'public.onboarding_steps', from: '0059', columns: ['closed_at', 'failures', 'state'] },
  { table: 'public.onboardings', from: '0059', columns: ['revision', 'state', 'stopped_at'] },
];

/** Select granted column by column (C31: custody's select leaves out the sealed columns). */
const COLUMN_SELECTS: readonly ColumnGrant[] = [
  {
    table: 'public.custody_secrets',
    from: '0053',
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
function columnUpdatesAt(at?: string): readonly string[] {
  return grantedAt(COLUMN_UPDATES, at);
}

/** The `table.column` pairs the application group may select column by column after `at`. */
function columnSelectsAt(at?: string): readonly string[] {
  return grantedAt(COLUMN_SELECTS, at);
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
    ...columnSelectsAt(at).map((pair) => `${APPLICATION_ROLE} SELECT ${pair}`),
    ...pairs.map((pair) => `${APPLICATION_ROLE} UPDATE ${pair}`),
    ...roleColumnGrantsAt(at),
  ];
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
