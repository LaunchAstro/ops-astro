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
  columnSelectsAt,
  columnUpdatesAt,
  describeOutcome,
} from './restricted-calls-cases.ts';
import {
  APPLICATION_CALLERS,
  fingerprint,
  type CallerName,
  type Callers,
} from './restricted-calls-callers.ts';

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
