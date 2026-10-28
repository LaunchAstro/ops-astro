// SPDX-License-Identifier: AGPL-3.0-only
//
// #2240: a transaction given a deadline (`tenancy/deadline.ts`) has its
// running statement cancelled at it, the commit-time checks included, which
// run as its last statement. A cancel can race the end of a statement and the
// COMMIT after it. Whatever the race, the transaction is atomic and the
// wrapper reports what the server did: a success has every row, a failure has
// none, and the connection goes on serving.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { FreshDatabase } from '../support/fresh-database.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';

const BUSINESS = randomUUID();
const COMMITTED = 'committed';
const CANCELLED = 'canceling statement due to user request';
const NOT_STARTED = 'the deadline has passed, so the statement was not started';
let db: FreshDatabase;
/** The runtime pool itself: `db.app` stands in front of it and passes no deadline on. */
let app: Database;

/** Rows whose commit-time check pauses `commit_ms` for each, in a deferred trigger. */
const ROWS = (login: string): string => `
  create table public.deadline_rows (tag int not null, n int not null, commit_ms int not null);
  grant select, insert on public.deadline_rows to "${login}";
  create function public.deadline_rows_slow() returns trigger language plpgsql as $$
    begin perform pg_sleep(new.commit_ms::float / 1000); return null; end $$;
  create constraint trigger deadline_rows_slow after insert on public.deadline_rows
    deferrable initially deferred for each row execute function public.deadline_rows_slow();
`;

/** Two rows, a pause between them, and commit-time checks that pause `commitMs` for each. */
async function twoRows(
  tag: number,
  deadline: number,
  pauseMs: number,
  commitMs: number,
): Promise<string> {
  return await app
    .withBusiness(
      BUSINESS,
      async (tx) => {
        await tx.query('insert into public.deadline_rows values ($1, 1, $2)', [tag, commitMs]);
        await tx.query('select pg_sleep($1::float / 1000)', [pauseMs]);
        await tx.query('insert into public.deadline_rows values ($1, 2, $2)', [tag, commitMs]);
      },
      { deadline },
    )
    .then(
      () => COMMITTED,
      (cause: unknown) => (cause instanceof Error ? cause.message : 'unknown'),
    );
}

async function rowsOf(tag: number): Promise<number> {
  const [row] = await db.admin.execute<{ rows: number }>(
    'select count(*)::int as rows from public.deadline_rows where tag = $1',
    [tag],
  );
  return row?.rows ?? -1;
}

/**
 * Two hundred transactions, each checked whole or absent, with deadlines
 * spread from before the first statement to past the COMMIT, scaled to how
 * long one transaction takes on this machine now. The outcomes, counted.
 */
async function raceTheDeadline(): Promise<Map<string, number>> {
  const began = performance.now();
  expect(await twoRows(0, Date.now() + 5_000, 3, 2)).toBe(COMMITTED);
  const span = (performance.now() - began) * 1.5;
  const seen = new Map<string, number>();
  for (let tag = 1; tag <= 200; tag += 1) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await twoRows(tag, Date.now() + Math.random() * span, 3, 2);
    // eslint-disable-next-line no-await-in-loop
    expect(await rowsOf(tag), `${outcome}: half applied`).toBe(outcome === COMMITTED ? 2 : 0);
    seen.set(outcome, (seen.get(outcome) ?? 0) + 1);
  }
  return seen;
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)('a transaction with a deadline', () => {
  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'deadlinewhole' });
    await db.admin.execute(ROWS(db.loginRole));
    app = connect(db.appUrl);
  }, 60_000);
  afterAll(async () => {
    await app.close();
    await db.drop();
  });

  it('a cancel racing a statement or its COMMIT leaves every transaction whole or absent', async () => {
    console.log('outcomes:', Object.fromEntries(await raceTheDeadline()));
    expect(await twoRows(1_000, Date.now() + 5_000, 0, 0)).toBe(COMMITTED);
  }, 60_000);

  it('a statement running at the deadline is cancelled, and nothing is applied', async () => {
    expect(await twoRows(2_000, Date.now() + 200, 1_000, 0)).toBe(CANCELLED);
    expect(await rowsOf(2_000)).toBe(0);
    expect(await twoRows(2_001, Date.now() + 5_000, 0, 0)).toBe(COMMITTED);
  });

  it('commit-time checks running past the deadline are cancelled before the COMMIT, and nothing is applied', async () => {
    expect(await twoRows(3_000, Date.now() + 200, 0, 600)).toBe(CANCELLED);
    expect(await rowsOf(3_000)).toBe(0);
    expect(await twoRows(3_001, Date.now() + 5_000, 0, 0)).toBe(COMMITTED);
    expect(await rowsOf(3_001)).toBe(2);
  });

  it('a deadline already passed begins no transaction', async () => {
    expect(await twoRows(4_000, Date.now() - 1, 0, 0)).toBe(NOT_STARTED);
    expect(await rowsOf(4_000)).toBe(0);
  });

  it('the server limits each statement to the time left and a margin, never to no limit', async () => {
    const [row] = await app.withBusiness(
      BUSINESS,
      async (tx) =>
        await tx.query<{ limit: string }>(`select current_setting('statement_timeout') as limit`),
      { deadline: Date.now() + 1_000 },
    );
    const ms = Number(/^(\d+)ms$/u.exec(row?.limit ?? '')?.[1]);
    expect(ms).toBeGreaterThan(1_000);
    expect(ms).toBeLessThanOrEqual(1_250);
  });
});
