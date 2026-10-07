// SPDX-License-Identifier: AGPL-3.0-only
//
// One login is a person or an agent, also between two Repeatable Read
// transactions.
//
// The mapping trigger waits on the shared login row and only then reads the
// other mapping table. Under read committed that read is a fresh snapshot and
// sees the first writer's committed mapping. Under Repeatable Read the
// snapshot is the one taken at the transaction's first statement: a row lock
// alone does not refresh it, so the second writer would read the other table
// as it was before the first committed, find nothing, and commit too.
//
// Both transactions here take their snapshots before either maps the login.
// The first maps it as a person and is held open; the second maps it as an
// agent and is observed waiting on a lock in `pg_stat_activity` (the helper
// throws if it never waits, so no interleaving is assumed). Then the first
// commits. The second must be refused, and exactly one active mapping exists.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import {
  insertActor,
  insertAgentActor,
  insertBusiness,
  insertLogin,
  insertPerson,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

function barrier(): { readonly held: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

/** Wait, bounded, until a backend in this database is parked on a lock. */
async function awaitBlockedOnLock(db: FreshDatabase, deadline: number): Promise<void> {
  const found = await db.admin.execute(
    `select 1 from pg_stat_activity
      where datname = current_database() and state = 'active' and wait_event_type = 'Lock'`,
  );
  if (found.length > 0) return;
  if (Date.now() > deadline) throw new Error('the second writer never waited on a lock');
  await delay(25);
  await awaitBlockedOnLock(db, deadline);
}

interface World {
  readonly db: FreshDatabase;
  readonly one: postgres.Sql;
  readonly two: postgres.Sql;
  readonly business: string;
  readonly personId: string;
  readonly personActorId: string;
  readonly agentActorId: string;
}

/**
 * Two Repeatable Read transactions, each with its snapshot taken before either
 * maps `loginId`. The first maps it as a person and is held open until the
 * second, mapping it as an agent, is seen waiting on a lock.
 */
async function mapBothWays(
  w: World,
  loginId: string,
): Promise<readonly [PromiseSettledResult<void>, PromiseSettledResult<void>]> {
  const firstSnapshot = barrier();
  const secondSnapshot = barrier();
  const written = barrier();
  const gate = barrier();
  // Each transaction's first statement sets the business and fixes its snapshot.
  const first = w.one.begin('isolation level repeatable read', async (tx) => {
    await tx`select set_config('app.business_id', ${w.business}, true)`;
    firstSnapshot.release();
    await secondSnapshot.held;
    await tx`insert into person_logins
               (business_id, id, login_id, person_id, active, linked_by_actor_id)
             values (${w.business}, ${randomUUID()}, ${loginId}, ${w.personId}, true,
                     ${w.personActorId})`;
    written.release();
    await gate.held;
  });
  const second = w.two.begin('isolation level repeatable read', async (tx) => {
    await tx`select set_config('app.business_id', ${w.business}, true)`;
    await firstSnapshot.held;
    secondSnapshot.release();
    await written.held;
    await tx`insert into actor_logins
               (business_id, id, login_id, actor_id, active, linked_by_actor_id)
             values (${w.business}, ${randomUUID()}, ${loginId}, ${w.agentActorId}, true,
                     ${w.personActorId})`;
  });
  let waited: unknown = null;
  try {
    await written.held;
    await awaitBlockedOnLock(w.db, Date.now() + 10_000);
  } catch (error) {
    waited = error;
  } finally {
    gate.release();
  }
  const settled = await Promise.allSettled([first, second]);
  if (waited !== null) throw waited;
  return [settled[0], settled[1]];
}

describe.skipIf(serverUrl === undefined)('one login, one kind, under Repeatable Read', () => {
  let w: World;

  beforeAll(async () => {
    const db = await createFreshDatabase({ part: 'l2rr' });
    // Two application connections, so the two transactions race in the server.
    const one = postgres(db.appUrl, { max: 1, onnotice: () => {} });
    const two = postgres(db.appUrl, { max: 1, onnotice: () => {} });
    const business = await insertBusiness(db.app, 'login-kind-rr');
    w = await db.app.withBusiness(business, async (tx) => {
      const personId = await insertPerson(tx, 'Ada');
      return {
        db,
        one,
        two,
        business,
        personId,
        personActorId: await insertActor(tx, personId),
        agentActorId: await insertAgentActor(tx),
      };
    });
  }, 60_000);

  afterAll(async () => {
    await w?.one.end();
    await w?.two.end();
    await w?.db.drop();
  });

  it('refuses the second of two mappings whose snapshots predate the first commit', async () => {
    const loginId = await w.db.app.withBusiness(w.business, (tx) =>
      insertLogin(tx, `rr-${randomUUID()}`),
    );
    const [first, second] = await mapBothWays(w, loginId);
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    const active = await w.db.admin.execute<{ readonly n: number }>(
      `select ((select count(*) from person_logins where login_id = $1 and active)
             + (select count(*) from actor_logins where login_id = $1 and active))::int as n`,
      [loginId],
    );
    expect(active[0]?.n).toBe(1);
  }, 60_000);
});
