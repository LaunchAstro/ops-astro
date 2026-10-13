// SPDX-License-Identifier: AGPL-3.0-only
// The second-model check's proof, kept as it was written: its schedule's
// latches and counters live in the test, and its poll waits on purpose.
/* oxlint-disable unicorn/consistent-function-scoping, no-await-in-loop, max-lines-per-function */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { hasRoom, type TenantQuery } from '../../packages/core-records/src/index.ts';
import { openSchedules, racer } from './schedules-harness.ts';

it.skipIf(process.env['DATABASE_URL'] === undefined)(
  'two spellings of one business cannot exceed its durable limit under a repeatable-read default',
  async () => {
    const world = await openSchedules('sol1397case', 1_000_000);
    const url = new URL(world.db.appUrl);
    url.searchParams.set('default_transaction_isolation', 'repeatable read');
    const firstDb = racer(world, url.toString());
    const secondDb = racer(world, url.toString());
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let announce = (): void => {};
    const ready = new Promise<void>((resolve) => {
      announce = resolve;
    });
    let announcePid = (_pid: number): void => {};
    const pidReady = new Promise<number>((resolve) => {
      announcePid = resolve;
    });
    let secondCounted = false;
    const count = async (tx: TenantQuery): Promise<number> => {
      const [row] = await tx.query<{ n: string }>(
        "select count(*)::text as n from public.actors where business_id = $1 and kind = 'agent'",
        [tx.businessId],
      );
      return Number(row?.n ?? 0);
    };
    const add = async (tx: TenantQuery): Promise<void> => {
      await tx.query("insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')", [
        tx.businessId,
        randomUUID(),
      ]);
    };
    const before = await firstDb.withBusiness(world.business, count);
    const limit = { name: `sol-case-${randomUUID()}`, limit: before + 1, count };
    const pending: Promise<boolean>[] = [];
    try {
      expect(world.business.toUpperCase()).not.toBe(world.business);
      pending.push(
        firstDb.withBusiness(world.business, async (tx) => {
          const room = await hasRoom(tx, [limit]);
          announce();
          await held;
          if (room) await add(tx);
          return room;
        }),
      );
      await ready;
      pending.push(
        secondDb.withBusiness(world.business.toUpperCase(), async (tx) => {
          const [row] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
          if (row === undefined) throw new Error('The competing backend is missing');
          announcePid(row.pid);
          const room = await hasRoom(tx, [
            {
              ...limit,
              count: async (query) => {
                const n = await count(query);
                secondCounted = true;
                return n;
              },
            },
          ]);
          if (room) await add(tx);
          return room;
        }),
      );
      const pid = await pidReady;
      let observed = false;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const [activity] = await world.db.admin.execute<{ waiting: boolean }>(
          "select wait_event_type = 'Lock' as waiting from pg_stat_activity where pid = $1",
          [pid],
        );
        if (secondCounted || activity?.waiting === true) {
          observed = true;
          break;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
      expect(observed, 'the competing transaction either counted or waited on the lock').toBe(true);
      release();
      const admitted = await Promise.all(pending);
      expect.soft(admitted.filter(Boolean)).toHaveLength(1);
      expect.soft(await firstDb.withBusiness(world.business, count)).toBe(before + 1);
    } finally {
      release();
      await Promise.allSettled(pending);
      await Promise.all([firstDb.close(), secondDb.close()]);
      await world.db.drop();
    }
  },
  60_000,
);
