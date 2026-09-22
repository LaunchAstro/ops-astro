// SPDX-License-Identifier: AGPL-3.0-only
//
// Two callers at once, on two connections, in two transactions.
//
// Everything else in this part runs one call at a time, and a register that
// only works when nobody is racing is a register that has not been tested. Two
// cases here, and each is a real property of the mechanism rather than a
// demonstration that Postgres locks:
//
// 1. **The same operation identity, twice at once.** One attempt commits and
//    the other is refused by the register's unique index. The loser's whole
//    transaction is gone and the winner's result is replayed, so two clients
//    retrying the same request cannot produce two records.
// 2. **Two creates at once.** `key` is assigned by counting, so both pick the
//    same number and the loser is refused by `record_unique_values`. The
//    retry runs in a fresh transaction, reads the winner's row and takes the
//    next number — which is the retry T1e's handback asked this part for.
//
// **What these two cases are not: forced.** The interleaving is left to the
// server. If one transaction commits before the other reads, the first case is
// an ordinary replay and the second never collides, and both pass without the
// retry executing. A review pointed that out and it is worth knowing: the
// assertions are right either way, but a green run here is not proof the retry
// ran. Forcing it needs a hook into the middle of the envelope's transaction,
// and the honest alternative — a deterministic collision — is unreachable,
// because `nextTaskKey` returns the maximum plus one and nothing can already
// hold that value.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { readAuditEvents } from '../../packages/core-records/src/commands/audit.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('concurrency: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

describe.skipIf(serverUrl === undefined)('two callers at once', () => {
  let db: FreshDatabase;
  let second: Database;
  let business: string;
  let worker: Member;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'f' });
    // A second connection, not a second transaction on the first: the first
    // has `max: 1`, so two calls on it would queue and prove nothing.
    second = connect(db.appUrl, { source: 'runtime' });
    business = await insertBusiness(db.app, 'concurrency');
    await installSpine(db.app, business);
    worker = await enrol(db.app, business, 'worker');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, worker, 'write');
    });
  }, 60_000);

  afterAll(async () => {
    await second?.close();
    await db?.drop();
  });

  const create = async (database: Database, title: string, operationId: string) =>
    await executeCommand(database, business, worker.presented, 'api', {
      command: 'task.create',
      operationId,
      fields: { title },
    });

  it('lets one identity through once and replays it for the other', async () => {
    const identity = `race-${randomUUID()}`;
    const [first, again] = await Promise.all([
      create(db.app, 'raced', identity),
      create(second, 'raced', identity),
    ]);
    expect(isCommandRefusal(first)).toBe(false);
    expect(isCommandRefusal(again)).toBe(false);
    // Same handle, so the same record: one of the two did the work and the
    // other was handed the answer.
    expect(again).toStrictEqual(first);

    const rows = await db.app.withBusiness(business, async (tx) =>
      tx.query<{ readonly count: string }>(
        `select count(*)::text as count from records
          where business_id = $1 and data ->> 'title' = 'raced'`,
        [business],
      ),
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('gives two simultaneous creates two keys, the loser taking the next one', async () => {
    const [left, right] = await Promise.all([
      create(db.app, 'left', randomUUID()),
      create(second, 'right', randomUUID()),
    ]);
    for (const outcome of [left, right]) {
      expect(isCommandRefusal(outcome) ? outcome.code : 'applied').toBe('applied');
    }
    const keys = await db.app.withBusiness(business, async (tx) =>
      tx.query<{ readonly key: string }>(
        `select data ->> 'key' as key from records
          where business_id = $1 and data ->> 'title' = any($2::text[]) order by 1`,
        [business, ['left', 'right']],
      ),
    );
    expect(keys.map((row) => row.key)).toHaveLength(2);
    expect(new Set(keys.map((row) => row.key)).size).toBe(2);
  });
});

// The other half of "every attempt writes an audit event": the attempts that
// raised rather than refusing.
//
// The fault is injected by taking the privilege away, as the owner, because
// every honest bad value is now a refusal rather than a raise — which is the
// right outcome and leaves this path with nothing to reach it. A revoked
// INSERT is a real production fault (a migration that forgot a grant) and it
// is deterministic, which a race is not.
describe.skipIf(serverUrl === undefined)('an attempt that raised', () => {
  let db: FreshDatabase;
  let business: string;
  let worker: Member;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'f' });
    business = await insertBusiness(db.app, 'faults');
    await installSpine(db.app, business);
    worker = await enrol(db.app, business, 'worker');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, worker, 'write');
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('records the attempt in the chain and hands the fault on', async () => {
    await db.admin.execute('revoke insert on public.records from ops_astro_app');
    try {
      await expect(
        executeCommand(db.app, business, worker.presented, 'api', {
          command: 'task.create',
          operationId: randomUUID(),
          fields: { title: 'no privilege' },
        }),
      ).rejects.toThrow(/permission denied/iu);
    } finally {
      await db.admin.execute('grant insert on public.records to ops_astro_app');
    }

    const events = await db.app.withBusiness(business, readAuditEvents);
    const failed = events.filter((event) => event.outcome === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.command).toBe('task.create');
    // No message, because a message may carry a value.
    expect(failed[0]?.refusal_code).toBeNull();
    expect(failed[0]?.attempted).toBeNull();

    // And the record itself did not land: the transaction that raised took
    // everything with it, including the register row.
    const rows = await db.app.withBusiness(business, async (tx) =>
      tx.query<{ readonly count: string }>(
        `select count(*)::text as count from operations where business_id = $1`,
        [business],
      ),
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('refuses a NUL byte in a text field rather than raising on it', async () => {
    const refusal = await executeCommand(db.app, business, worker.presented, 'api', {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: `a${String.fromCodePoint(0)}b` },
    });
    expect(isCommandRefusal(refusal) && refusal.code).toBe('FIELD_VALUE_INVALID');
  });
});
