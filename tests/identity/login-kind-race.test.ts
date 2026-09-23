// SPDX-License-Identifier: AGPL-3.0-only
//
// Finding 2: two transactions cannot make one login both a person and an agent.
//
// 0008 states the rule and enforces it with two triggers, each reading the
// other mapping table before permitting its own write. Under read committed
// that is not exclusion: both transactions run their `select` before either
// commits, both see nothing, and both commit. The per-table unique indexes are
// on different tables and never meet.
//
// **Why this forces the race rather than hoping for it**, the way
// `tests/commands/lost-update.test.ts` does. Two connections, each holding its
// own transaction open across a barrier the test releases by hand. The second
// transaction is not slept past: `awaitBlockedOnLock` asks `pg_stat_activity`
// until a backend in this database is parked on a lock, which is the second
// writer sitting inside the trigger's `select ... for update` on the shared
// login row. If that state never appears the helper throws, so a run that
// could not establish the interleaving fails loudly instead of passing quietly.
//
// Against 0008's function nothing blocks, both writers commit, and the
// assertion that exactly one committed fails. Against 0015's the second waits,
// reads the first's committed mapping, and raises `unique_violation`.
//
// Two cases, as the finding asks: a simultaneous insert of both kinds, and an
// inactive-to-active update racing an insert of the other kind.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import {
  insertActor,
  insertAgentActor,
  insertBusiness,
  insertLogin,
  insertPerson,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'login-kind-race: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

/** A promise a test resolves by hand, which is how a transaction is held open. */
function barrier(): { readonly held: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** How long the interleaving is given to appear. Generous, and finite. */
const WITHIN = 10_000;

/**
 * Wait, bounded, until a backend in this database is blocked on a lock.
 *
 * Recursion rather than a loop, because the repository's lint forbids awaiting
 * in one. The owner connection asks, because both application connections are
 * inside transactions of their own.
 */
async function awaitBlockedOnLock(db: FreshDatabase, deadline: number): Promise<string> {
  const rows = await db.admin.execute<{ readonly query: string }>(
    `select query
       from pg_stat_activity
      where datname = current_database()
        and state = 'active'
        and wait_event_type = 'Lock'
      limit 1`,
  );
  const found = rows[0];
  if (found !== undefined) return found.query;
  if (Date.now() > deadline) {
    throw new Error(
      'the second writer never blocked on a lock: the trigger did not serialise on the ' +
        'shared login row, so this run establishes no interleaving',
    );
  }
  await delay(25);
  return awaitBlockedOnLock(db, deadline);
}

function errorCodeOf(error: unknown): string {
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : String(error);
}

describe.skipIf(serverUrl === undefined)('one login is a person or an agent', () => {
  let db: FreshDatabase;
  let second: Database;
  let business: string;
  let personId: string;
  let personActorId: string;
  let agentActorId: string;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'l2r' });
    // A second connection, because the first is `max: 1` and two transactions
    // on it would queue in the pool rather than race in the server.
    second = connect(db.appUrl, { source: 'runtime' });
    business = await insertBusiness(db.app, 'login-kind');
    await db.app.withBusiness(business, async (tx) => {
      personId = await insertPerson(tx, 'Ada');
      personActorId = await insertActor(tx, personId);
      agentActorId = await insertAgentActor(tx);
    });
  }, 60_000);

  afterAll(async () => {
    await second?.close();
    await db?.drop();
  });

  /**
   * Run two writers against one login with the first held open across a
   * barrier, and report what each one did. `first` commits; `second` is
   * started only once `first` has written, and is observed to block.
   */
  async function race(
    loginId: string,
    firstWrite: (tx: {
      query: (text: string, parameters?: readonly unknown[]) => Promise<readonly unknown[]>;
    }) => Promise<void>,
    secondWrite: (tx: {
      query: (text: string, parameters?: readonly unknown[]) => Promise<readonly unknown[]>;
    }) => Promise<void>,
  ): Promise<readonly [PromiseSettledResult<void>, PromiseSettledResult<void>]> {
    const written = barrier();
    const gate = barrier();

    const firstRun = db.app.withBusiness(business, async (tx) => {
      await firstWrite(tx);
      written.release();
      await gate.held;
    });

    await written.held;

    const secondRun = second.withBusiness(business, async (tx) => {
      await secondWrite(tx);
    });

    // The evidence that the second writer reached the contested point rather
    // than starting after the first had finished.
    const blocked = await awaitBlockedOnLock(db, Date.now() + WITHIN);
    expect(blocked.length).toBeGreaterThan(0);

    gate.release();
    const settled = await Promise.allSettled([firstRun, secondRun]);
    void loginId;
    return [settled[0], settled[1]];
  }

  const insertPersonMapping =
    (loginId: string) =>
    async (tx: {
      query: (text: string, parameters?: readonly unknown[]) => Promise<readonly unknown[]>;
    }) => {
      await tx.query(
        `insert into person_logins
         (business_id, id, login_id, person_id, active, linked_by_actor_id)
       values ($1, $2, $3, $4, true, $5)`,
        [business, randomUUID(), loginId, personId, personActorId],
      );
    };

  const insertAgentMappingRow =
    (loginId: string) =>
    async (tx: {
      query: (text: string, parameters?: readonly unknown[]) => Promise<readonly unknown[]>;
    }) => {
      await tx.query(
        `insert into actor_logins
         (business_id, id, login_id, actor_id, active, linked_by_actor_id)
       values ($1, $2, $3, $4, true, $5)`,
        [business, randomUUID(), loginId, agentActorId, personActorId],
      );
    };

  const activeMappings = async (loginId: string): Promise<number> =>
    await db.app.withBusiness(business, async (tx) => {
      const rows = await tx.query<{ readonly n: string }>(
        `select (
           (select count(*) from person_logins where business_id = $1 and login_id = $2 and active)
         + (select count(*) from actor_logins  where business_id = $1 and login_id = $2 and active)
         )::text as n`,
        [business, loginId],
      );
      return Number(rows[0]?.n ?? '-1');
    });

  it('refuses the second of two simultaneous mappings of different kinds', async () => {
    const loginId = await db.app.withBusiness(business, async (tx) =>
      insertLogin(tx, `race-insert-${randomUUID()}`),
    );

    const [first, secondResult] = await race(
      loginId,
      insertPersonMapping(loginId),
      insertAgentMappingRow(loginId),
    );

    expect(first.status).toBe('fulfilled');
    expect(secondResult.status).toBe('rejected');
    if (secondResult.status === 'rejected') {
      expect(errorCodeOf(secondResult.reason)).toBe('23505');
    }
    // The fact the finding is about: one login, one kind, whatever the timing.
    expect(await activeMappings(loginId)).toBe(1);
  }, 60_000);

  it('refuses an insert racing an inactive-to-active update of the other kind', async () => {
    const loginId = await db.app.withBusiness(business, async (tx) => {
      const id = await insertLogin(tx, `race-update-${randomUUID()}`);
      // The person mapping exists and is inactive, so it is not yet a conflict.
      await tx.query(
        `insert into person_logins
           (business_id, id, login_id, person_id, active, linked_by_actor_id, deactivated_at)
         values ($1, $2, $3, $4, false, $5, now())`,
        [business, randomUUID(), id, personId, personActorId],
      );
      return id;
    });

    const activate = async (tx: {
      query: (text: string, parameters?: readonly unknown[]) => Promise<readonly unknown[]>;
    }) => {
      await tx.query(
        `update person_logins set active = true, deactivated_at = null
          where business_id = $1 and login_id = $2`,
        [business, loginId],
      );
    };

    const [first, secondResult] = await race(loginId, activate, insertAgentMappingRow(loginId));

    expect(first.status).toBe('fulfilled');
    expect(secondResult.status).toBe('rejected');
    if (secondResult.status === 'rejected') {
      expect(errorCodeOf(secondResult.reason)).toBe('23505');
    }
    expect(await activeMappings(loginId)).toBe(1);
  }, 60_000);
});
