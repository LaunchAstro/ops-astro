// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's turn on the owner's plan holds nothing (#2091, design v3, gap
// v2-2), as PostgreSQL itself keeps it. A task call that is not refused may
// hold nothing only as the agent's turn (`model.agent_turn`) on a cloud
// route under a subscription, in every state such a call reaches, and settled
// at nothing. The exception must be true: with no credential kind or no
// reach, another kind, a local reach or another operation, a zero hold is
// refused, on insert and on an update to it. Each row copies a real call's
// row, so the rest of the table's rules hold as they would.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { liveWork } from '../runtime/schedules-harness.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { leaseOf, s, signedIn, useDoorWorld } from './run-stop-door-world.ts';
import { firstTurn, turnBroker } from './turn-world.ts';

const serverUrl = databaseUrlFromEnvironment();
const CONSTRAINT = 'model_calls_hold_only_when_refused';
const TURN = 'model.agent_turn';

type Over = Readonly<Record<string, unknown>>;
type Execute = Parameters<Parameters<typeof s.db.admin.transaction>[0]>[0];

const ROLLBACK = new Error('rolled back on purpose');

/** The constraint a refusal names, or `kept` when the row stood (and was rolled back). */
async function judged(
  source: string,
  over: Over,
  then?: (execute: Execute, id: string) => Promise<unknown>,
) {
  const id = randomUUID();
  try {
    await s.db.admin.transaction(async (execute) => {
      const columns = await execute<{ column_name: string; udt_name: string }>(
        `select column_name, udt_name from information_schema.columns
          where table_schema = 'public' and table_name = 'model_calls' order by ordinal_position`,
      );
      const values = { ...over, id, call_ordinal: null, call_limit: null };
      const keys = Object.keys(values);
      const list = columns.map(({ column_name: name, udt_name: type }) =>
        keys.includes(name) ? `$${String(keys.indexOf(name) + 2)}::${type}` : name,
      );
      await execute(
        `insert into public.model_calls (${columns.map((c) => c.column_name).join(', ')})
         select ${list.join(', ')} from public.model_calls where id = $1`,
        [source, ...keys.map((key) => values[key as keyof typeof values])],
      );
      await then?.(execute, id);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error === ROLLBACK) return 'kept';
    const shape = error as { code?: string; constraint?: string; constraint_name?: string };
    if (shape.code !== '23514') throw error;
    return shape.constraint ?? shape.constraint_name ?? 'unnamed';
  }
  return 'committed';
}

const ZERO: Over = {
  reserved_minor: 0,
  credential_kind: 'subscription',
  route_reach: 'cloud',
  operation_key: TURN,
  drop_state: null,
};

/** Each state a zero hold reaches, with the facts that state carries. */
const STATES: readonly Over[] = [
  { state: 'reserved', actual_minor: null },
  { state: 'dispatched', actual_minor: null },
  { state: 'settled', actual_minor: 0 },
  { state: 'released', actual_minor: null },
  { state: 'liability_unknown', actual_minor: null },
];

const REFUSED: readonly { readonly name: string; readonly over: Over }[] = [
  { name: 'no credential kind', over: { credential_kind: null } },
  { name: 'no reach', over: { route_reach: null } },
  { name: 'neither', over: { credential_kind: null, route_reach: null } },
  { name: 'an API key', over: { credential_kind: 'api_key' } },
  { name: 'a local reach', over: { route_reach: 'local' } },
  { name: 'another operation', over: { operation_key: 'model.replay_turn' } },
];

const REFUSED_AT = STATES.flatMap((at) =>
  REFUSED.map(({ name, over }) => ({ name, over, at, state: String(at['state']) })),
);

const UNSET_AT = STATES.flatMap((at) =>
  ['credential_kind', 'route_reach'].map((column) => ({ at, column, state: String(at['state']) })),
);

describe.skipIf(serverUrl === undefined)('a zero hold on the plan turn', () => {
  useDoorWorld('planturnzero', turnBroker(10));
  let source = '';

  beforeAll(async () => {
    const work = await liveWork(s, 'plan turn zero hold', 2_000);
    await firstTurn(work, await signedIn());
    const [row] = await s.db.admin.execute<{ id: string }>(
      `select id from public.model_calls where business_id = $1 and lease_id = $2`,
      [s.business, leaseOf(work)],
    );
    source = String(row?.id);
  });

  it.each(STATES)('stands as the agent turn on a cloud subscription route, $state', async (at) => {
    expect(await judged(source, { ...ZERO, ...at })).toBe('kept');
  });

  it.each(REFUSED_AT)('is refused with $name, $state', async ({ at, over }) => {
    expect(await judged(source, { ...ZERO, ...at, ...over })).toBe(CONSTRAINT);
  });

  it.each(UNSET_AT)('is refused when an update unsets $column, $state', async ({ at, column }) => {
    const unset = async (execute: Execute, id: string) =>
      await execute(`update public.model_calls set ${column} = null where id = $1`, [id]);
    expect(await judged(source, { ...ZERO, ...at }, unset)).toBe(CONSTRAINT);
  });

  it('settles at nothing, never more than it held', async () => {
    expect(await judged(source, { ...ZERO, state: 'settled', actual_minor: 1 })).toBe(
      'model_calls_actual_within_hold',
    );
  });

  it('keeps a refusal at nothing, and a held task call above nothing', async () => {
    expect(await judged(source, { state: 'reserved', reserved_minor: 0, actual_minor: null })).toBe(
      CONSTRAINT,
    );
  });
});
