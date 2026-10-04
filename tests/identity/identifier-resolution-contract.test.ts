// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable unicorn/consistent-function-scoping, no-await-in-loop, no-unmodified-loop-condition, max-lines-per-function -- the review's proofs, kept as written */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveIdentifier } from '../../packages/core-records/src/identity/identifier-resolution.ts';
import {
  connect,
  type Database,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
import {
  insertActor,
  insertBusiness,
  insertIdentifier,
  insertMerge,
  insertPerson,
} from './fixture.ts';

function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((open) => {
    resolve = open;
  });
  return { promise, resolve };
}

describe('identifier resolution contract', () => {
  let db: FreshDatabase;
  let second: Database;
  let business: string;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'sol810' });
    business = await insertBusiness(db.app, 'sol810');
    second = connect(db.appUrl);
  }, 60_000);

  afterAll(async () => {
    await second?.close();
    await db?.drop();
  });

  it('concurrent unresolved batches in opposite order both commit', async () => {
    const values = ['batch-a@example.com', 'batch-b@example.com'];
    await db.app.withBusiness(business, async (tx) => {
      for (const value of values) {
        for (const name of ['One', 'Two']) {
          const person = await insertPerson(tx, name);
          await insertIdentifier(tx, person, value);
        }
      }
    });
    const gate = signal();
    let arrived = 0;
    const batch = (app: Database, order: readonly string[]) =>
      app.withBusiness(business, async (tx) => {
        for (const [index, value] of order.entries()) {
          const result = await resolveIdentifier(tx, {
            kind: 'email',
            value,
            sourceSystem: 'import',
          });
          expect(result.outcome).toBe('unresolved');
          if (index === 0) {
            arrived += 1;
            if (arrived === 2) gate.resolve();
            await gate.promise;
          }
        }
      });
    const results = await Promise.allSettled([
      batch(db.app, values),
      batch(second, values.toReversed()),
    ]);
    expect(
      results.map((result) =>
        result.status === 'fulfilled'
          ? 'committed'
          : result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      ),
    ).toEqual(['committed', 'committed']);
  }, 30_000);

  it('a merge-survivor attachment preserves the rejected link as decision evidence', async () => {
    const value = 'rejected-survivor@example.com';
    const rejectedId = await db.app.withBusiness(business, async (tx) => {
      const survivor = await insertPerson(tx, 'Survivor');
      const absorbed = await insertPerson(tx, 'Absorbed');
      const actor = await insertActor(tx, survivor);
      const id = await insertIdentifier(tx, survivor, value, 'human-reviewed-source');
      await insertIdentifier(tx, absorbed, value, 'crm');
      await insertMerge(tx, survivor, absorbed, actor);
      await tx.query("update person_identifiers set review_state = 'rejected' where id = $1", [id]);
      return id;
    });
    const rejectedRow = () =>
      db.app.withBusiness(business, (tx) =>
        tx.query('select * from person_identifiers where id = $1', [rejectedId]),
      );
    const before = await rejectedRow();
    await db.app.withBusiness(business, (tx) =>
      resolveIdentifier(tx, {
        kind: 'email',
        value: ' Rejected-Survivor@Example.com ',
        sourceSystem: 'new-import',
        sourceId: 'new-id',
      }),
    );
    expect(await rejectedRow()).toStrictEqual(before);
  });

  it('business to business observations never attach to or update the other business', async () => {
    const other = await insertBusiness(db.app, 'sol810-other');
    const value = 'business-boundary@example.com';
    const observation = { kind: 'email', value, sourceSystem: 'import' } as const;
    const first = await db.app.withBusiness(business, (tx) => resolveIdentifier(tx, observation));
    const state = () =>
      db.app.withBusiness(business, (tx) =>
        tx.query('select * from person_identifiers where value = $1', [value]),
      );
    const before = await state();
    const next = await second.withBusiness(other, (tx) => resolveIdentifier(tx, observation));
    expect(first.outcome).toBe('attached');
    expect(next).toMatchObject({ outcome: 'attached', person: 'new' });
    expect(next).not.toEqual(first);
    expect(await state()).toStrictEqual(before);
  });

  it('business UUID letter casing does not split the first-sighting lock', async () => {
    const lower = 'a8100000-0000-4000-8000-000000000000';
    const upper = lower.toUpperCase();
    await db.app.withBusiness(lower, (tx) =>
      tx.query('insert into businesses (business_id, id, key, name) values ($1, $1, $2, $2)', [
        lower,
        'uuid-case',
      ]),
    );
    const gate = signal();
    let arrived = 0;
    const pids: number[] = [];
    const value = 'uuid-case@example.com';
    const run = (app: Database, businessId: string) =>
      app.withBusiness(businessId, async (tx) => {
        const [backend] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
        if (backend === undefined) throw new Error('missing backend');
        pids.push(backend.pid);
        const held: TenantQuery = {
          businessId: tx.businessId,
          async query<Row>(text: string, parameters?: readonly unknown[]): Promise<readonly Row[]> {
            const rows = await tx.query<Row>(text, parameters);
            if (/from public\.person_identifiers\s+where kind/u.test(text)) {
              arrived += 1;
              if (arrived === 2) gate.resolve();
              await gate.promise;
            }
            return rows;
          },
        };
        return resolveIdentifier(held, { kind: 'email', value, sourceSystem: 'import' });
      });
    const calls = Promise.allSettled([run(db.app, lower), run(second, upper)]);
    const deadline = Date.now() + 10_000;
    try {
      while (arrived < 2) {
        const [waiting] = await db.admin.execute<{ n: string }>(
          `select count(*)::text as n from pg_stat_activity
            where pid = any($1::int[]) and wait_event_type = 'Lock' and wait_event = 'advisory'`,
          [pids],
        );
        if (arrived === 1 && Number(waiting?.n) === 1) break;
        if (Date.now() > deadline)
          throw new Error('neither both lookups nor an advisory waiter appeared');
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
      }
    } finally {
      gate.resolve();
    }
    const results = await calls;
    const resolutions = results.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      if (result.value.outcome !== 'attached') throw new Error('expected attached');
      return result.value;
    });
    expect(resolutions[0]?.personId).toBe(resolutions[1]?.personId);
    const people = await db.app.withBusiness(lower, (tx) =>
      tx.query<{ n: string }>('select count(*)::text as n from people'),
    );
    expect(Number(people[0]?.n)).toBe(1);
  }, 30_000);

  it('simultaneous first observations sharing one transaction create one person', async () => {
    const observation = {
      kind: 'email',
      value: 'same-transaction@example.com',
      sourceSystem: 'import',
    } as const;
    const results = await db.app.withBusiness(business, (tx) =>
      Promise.all([resolveIdentifier(tx, observation), resolveIdentifier(tx, observation)]),
    );
    const people = results.map((result) => {
      if (result.outcome !== 'attached') throw new Error('expected attached');
      return result.personId;
    });
    expect(new Set(people).size).toBe(1);
    const rows = await db.app.withBusiness(business, (tx) =>
      tx.query<{ n: string }>(
        'select count(distinct person_id)::text as n from person_identifiers where value = $1',
        [observation.value],
      ),
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });
});
