// SPDX-License-Identifier: AGPL-3.0-only
//
// The C39-T races' tools: transactions on connections of their own, each
// named (`application_name`), so the server is asked only about the test's
// own backends, a transaction that holds an invitation's row until it is let
// go, waits on what the server says is parked, and one act per transaction.

import { randomUUID } from 'node:crypto';
import { runCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { withSession } from '../../packages/core-records/src/identity/login-resolution.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import type { Member } from '../commands/fixture.ts';
import { w } from './c39-t-world.ts';

export const delay = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A promise the test resolves by hand. */
export function barrier(): { readonly held: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

/** A connection of its own, and the name the server knows it by. */
export interface Own {
  readonly db: Database;
  readonly name: string;
}

/** Its own connection: one pool's transactions would queue in the pool, not race in the server. */
export function own(): Own {
  const name = `c39t-${randomUUID().slice(0, 8)}`;
  const url = new URL(w.db.appUrl);
  url.searchParams.set('application_name', name);
  return { db: connect(url.toString(), { source: 'runtime' }), name };
}

/**
 * A transaction on `database` that locks the invitation's row, runs `work`
 * under that lock, and holds it until it is let go; then it commits.
 */
export async function holdRow(
  database: Database,
  id: string,
  work: (tx: TenantQuery) => Promise<void> = async () => {},
): Promise<() => Promise<void>> {
  const [row, taken] = [barrier(), barrier()];
  const holding = database.withBusiness(w.alpha, async (tx) => {
    await tx.query('select id from invitations where business_id = $1 and id = $2 for update', [
      tx.businessId,
      id,
    ]);
    await work(tx);
    taken.release();
    await row.held;
  });
  await taken.held;
  return async () => {
    row.release();
    await holding;
  };
}

/** Wait, bounded, until `count` of the named connections are parked on a lock. */
export async function parked(
  count: number,
  names: readonly string[],
  deadline: number = Date.now() + 15_000,
): Promise<void> {
  const [row] = await w.db.admin.execute<{ n: number }>(
    `select count(*)::int as n from pg_stat_activity
      where datname = current_database() and application_name = any($1::text[])
        and state = 'active' and wait_event_type = 'Lock'`,
    [names],
  );
  if ((row?.n ?? 0) >= count) return;
  if (Date.now() > deadline) throw new Error(`fewer than ${String(count)} transactions parked`);
  await delay(25);
  await parked(count, names, deadline);
}

/** The locks the named connections wait on and have not been granted: one row each. */
export async function ungranted(
  names: readonly string[],
): Promise<readonly { name: string; locktype: string }[]> {
  return await w.db.admin.execute<{ name: string; locktype: string }>(
    `select a.application_name as name, l.locktype
       from pg_locks l join pg_stat_activity a on a.pid = l.pid
      where not l.granted and a.application_name = any($1::text[])
      order by a.application_name`,
    [names],
  );
}

/** One act as a person, one transaction on its own connection, so acts race in the server. */
export async function act(
  database: Database,
  who: Member,
  body: Readonly<Record<string, unknown>>,
): Promise<string> {
  const request = { operationId: randomUUID(), ...body } as never;
  try {
    const result = await withSession(
      database,
      w.alpha,
      who.presented,
      async (tx, session) => await runCommand(tx, session, 'api', request),
    );
    return isCommandRefusal(result) ? result.code : 'applied';
  } catch (cause) {
    return `threw ${String((cause as { code?: unknown }).code)}`;
  }
}
