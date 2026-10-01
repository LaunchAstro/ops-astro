// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01's durable limit as the one limiter (#483: C33's occurrence rates and
// its run ceiling reuse it, with no second limiter). The count is read back
// from the records under a lock of the business's own, so a restart never
// resets it, two transactions of one business at the limit admit one, and a
// business at its limit never delays another.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import {
  hasRoom,
  type Database,
  type DurableLimit,
  type TenantQuery,
} from '../../packages/core-records/src/index.ts';
import { openSchedules, racer, seedSchedules, type Schedules } from './schedules-harness.ts';

const noDatabase = process.env['DATABASE_URL'] === undefined;
const it = noDatabase ? vitestIt.skip : vitestIt;

let alpha: Schedules;
let bravo: Schedules;
const racers: Database[] = [];

beforeAll(async () => {
  if (noDatabase) return;
  alpha = await openSchedules('aw01limit', 1_000_000);
  bravo = await seedSchedules(alpha.db, 'aw01limit-bravo', 1_000_000);
}, 180_000);

afterAll(async () => {
  if (noDatabase) return;
  await Promise.all(racers.map(async (db) => await db.close()));
  await alpha.db.drop();
});

const fixed = (n: number) => async (): Promise<number> => await Promise.resolve(n);

/** A second backend on the same database. */
function backend(): Database {
  const db = racer(alpha);
  racers.push(db);
  return db;
}

/** The business's agent actors: a real record count, read inside the transaction. */
async function agents(tx: TenantQuery): Promise<number> {
  const [row] = await tx.query<{ n: string }>(
    `select count(*)::text as n from public.actors where business_id = $1 and kind = 'agent'`,
    [tx.businessId],
  );
  return Number(row?.n ?? 0);
}

const addAgent = async (tx: TenantQuery): Promise<void> => {
  await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
    tx.businessId,
    randomUUID(),
  ]);
};

const pause = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

it('AW-01 durable limit: admits up to the exact limit and refuses one past it, over every limit given', async () => {
  const at = async (limits: DurableLimit[]): Promise<boolean> =>
    await alpha.db.app.withBusiness(alpha.business, async (tx) => await hasRoom(tx, limits));
  const rate = (n: number): DurableLimit => ({ name: 'rate', limit: 60, count: fixed(n) });
  expect(await at([rate(59)])).toBe(true);
  expect(await at([rate(60)])).toBe(false);
  expect(await at([rate(61)])).toBe(false);
  expect(await at([rate(0), { name: 'runs', limit: 5, count: fixed(5) }])).toBe(false);
  expect(await at([rate(59), { name: 'runs', limit: 5, count: fixed(4) }])).toBe(true);
});

it('AW-01 durable limit: a limit that is not a whole number of at least 1 has no room, and nothing is counted', async () => {
  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    let counted = false;
    const count = async (): Promise<number> => {
      counted = true;
      return await Promise.resolve(0);
    };
    // eslint-disable-next-line no-await-in-loop
    const room = await alpha.db.app.withBusiness(
      alpha.business,
      async (tx) => await hasRoom(tx, [{ name: 'malformed', limit, count }]),
    );
    expect(room, String(limit)).toBe(false);
    expect(counted, String(limit)).toBe(false);
  }
});

it('AW-01 durable limit: two transactions of one business at the limit admit exactly one, the count read back from the records', async () => {
  const before = await alpha.db.app.withBusiness(alpha.business, agents);
  const limit: DurableLimit = {
    name: `agents-${randomUUID()}`,
    limit: before + 1,
    count: agents,
  };
  const attempt = async (db: Database): Promise<boolean> =>
    await db.withBusiness(alpha.business, async (tx) => {
      if (!(await hasRoom(tx, [limit]))) return false;
      // Hold the lock past the other's attempt, so the two overlap.
      await pause(300);
      await addAgent(tx);
      return true;
    });
  const admitted = await Promise.all([attempt(alpha.db.app), attempt(backend())]);
  expect(admitted.filter(Boolean)).toHaveLength(1);
  expect(await alpha.db.app.withBusiness(alpha.business, agents)).toBe(before + 1);
  // A fresh backend, as after a restart, reads the same count and the limit holds.
  expect(await attempt(backend())).toBe(false);
});

it('AW-01 durable limit: a business at its limit never delays another business on the same limit', async () => {
  const name = `shared-${randomUUID()}`;
  const gate: { open?: () => void } = {};
  const held = new Promise<void>((resolve) => {
    gate.open = resolve;
  });
  const holding = alpha.db.app.withBusiness(alpha.business, async (tx) => {
    await hasRoom(tx, [{ name, limit: 1, count: fixed(0) }]);
    await held;
  });
  await pause(100);
  const started = Date.now();
  const other = await backend().withBusiness(
    bravo.business,
    async (tx) => await hasRoom(tx, [{ name, limit: 1, count: fixed(0) }]),
  );
  const waited = Date.now() - started;
  gate.open?.();
  await holding;
  expect(other).toBe(true);
  expect(waited).toBeLessThan(2_000);

  // The same business on the same limit does wait for the holder.
  let ownDone = false;
  const holdingAgain = alpha.db.app.withBusiness(alpha.business, async (tx) => {
    await hasRoom(tx, [{ name, limit: 1, count: fixed(0) }]);
    await pause(500);
  });
  await pause(100);
  const own = (async (): Promise<void> => {
    await backend().withBusiness(
      alpha.business,
      async (tx) => await hasRoom(tx, [{ name, limit: 1, count: fixed(0) }]),
    );
    ownDone = true;
  })();
  await pause(200);
  expect(ownDone, 'the same business waited for the lock').toBe(false);
  await holdingAgain;
  await own;
  expect(ownDone).toBe(true);
});
