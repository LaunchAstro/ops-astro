// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T rate limit and expiry, one lock order: a resend and a create for the
// same address, racing as the invitation lapses, never deadlock. `create`
// ends a lapsed invitation of its address under the limiter's locks, so a
// resend must take the limiter before the invitation's row, as create does.
//
// The race is driven, not hoped for. A third transaction holds the
// invitation's row. The resend starts while the invitation is still live and
// parks; the create starts once the database clock has passed the expiry and
// parks; then the row is let go. Under the other order the resend held the
// row and waited on the limiter the create held, while the create waited on
// the row: the server's deadlock check killed one of them. Each act is one
// transaction here, as `runCommand` runs it: `executeCommand` retries a
// deadlock once, which hides one such cycle behind a second's stall and
// surfaces the next.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { withSession } from '../../packages/core-records/src/identity/login-resolution.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import type { Member } from '../commands/fixture.ts';
import {
  addressFor,
  c,
  codeOf,
  invitationRow,
  invite,
  noDatabase,
  useInvitationWorld,
  w,
} from './c39-t-world.ts';

useInvitationWorld();

const delay = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A promise the test resolves by hand. */
function barrier(): { readonly held: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

/** Its own connection: one pool's transactions would queue in the pool, not race in the server. */
const own = (): Database => connect(w.db.appUrl, { source: 'runtime' });

/** A transaction on `database` holding the invitation's row until it is let go. */
async function holdRow(database: Database, id: string): Promise<() => Promise<void>> {
  const [row, taken] = [barrier(), barrier()];
  const holding = database.withBusiness(w.alpha, async (tx) => {
    await tx.query('select id from invitations where business_id = $1 and id = $2 for update', [
      tx.businessId,
      id,
    ]);
    taken.release();
    await row.held;
  });
  await taken.held;
  return async () => {
    row.release();
    await holding;
  };
}

/** Wait, bounded, until `count` backends of this database are parked on a lock. */
async function parked(count: number, deadline = Date.now() + 15_000): Promise<void> {
  const [row] = await w.db.admin.execute<{ n: number }>(
    `select count(*)::int as n from pg_stat_activity
      where datname = current_database() and state = 'active' and wait_event_type = 'Lock'`,
  );
  if ((row?.n ?? 0) >= count) return;
  if (Date.now() > deadline) throw new Error(`fewer than ${String(count)} transactions parked`);
  await delay(25);
  await parked(count, deadline);
}

/** Wait until the database clock is past the invitation's expiry. */
async function lapsed(id: string): Promise<void> {
  const [row] = await w.db.admin.execute<{ lapsed: boolean }>(
    'select clock_timestamp() > expires_at as lapsed from public.invitations where id = $1',
    [id],
  );
  if (row?.lapsed === true) return;
  await delay(50);
  await lapsed(id);
}

/** One act as a person, one transaction on its own connection, so acts race in the server. */
async function act(
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
    return 'refused' in result ? 'LOGIN_REFUSED' : codeOf(result);
  } catch (cause) {
    return `threw ${String((cause as { code?: unknown }).code)}`;
  }
}

describe.skipIf(noDatabase)('C39-T invitation lock order', () => {
  it('C39-T rate limit: a resend and a create for the same address, racing at expiry, both finish and the resend wins', async () => {
    const address = addressFor('Lock-Order');
    const id = await invite(c.admin, address);
    await w.db.admin.execute(
      `update public.invitations set expires_at = now() + interval '3 seconds' where id = $1`,
      [id],
    );
    const [holder, resender, creator] = [own(), own(), own()] as const;
    try {
      const letGo = await holdRow(holder, id);
      // Started while the invitation is live: the resend's own clock says so.
      const resend = act(resender, c.admin, {
        command: 'invitation.resend',
        invitationId: id,
      });
      await parked(1);
      await lapsed(id);
      const create = act(creator, c.second, {
        command: 'invitation.create',
        name: 'Lee Lock',
        email: address,
        role: 'member',
      });
      await parked(2);
      await letGo();
      expect(await Promise.all([resend, create])).toEqual(['applied', 'UNIQUE_VALUE_TAKEN']);
      expect(await invitationRow(id)).toMatchObject({ state: 'pending', revision: 2 });
    } finally {
      await Promise.all([holder, resender, creator].map(async (db) => await db.close()));
    }
  }, 60_000);
});
