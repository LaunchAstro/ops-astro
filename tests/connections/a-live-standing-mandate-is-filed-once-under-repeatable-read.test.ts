// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one world, the two transactions step by step */
//
// One live standing mandate per filing (#1427), also between two Repeatable
// Read transactions that bypass the command.
//
// `standing_mandates_one_live_filing` takes the client row `for no key update`
// and only then asks `standing_mandate_live_filing` for an identical live
// mandate. Under read committed that read is a fresh snapshot and sees the
// first writer's committed mandate. Under Repeatable Read the snapshot is the
// one taken at the transaction's first statement: a row lock alone does not
// refresh it, so the second writer would read the mandates as they were
// before the first committed, find nothing, and commit too.
//
// Both transactions take their snapshots before either inserts. The first
// inserts and is held open; the second inserts the same filing and is
// observed waiting on a lock in `pg_stat_activity`. Then the first commits.
// The second must be refused, by the trigger (23505) or by a serialization
// failure (40001), and exactly one live mandate carries the filing.

import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { buildMandatesWorld, gate, inDays, type MandatesWorld } from './mandates-world.ts';

const serverUrl = databaseUrlFromEnvironment();

const codeOf = (settled: PromiseSettledResult<void>): string =>
  settled.status === 'fulfilled'
    ? 'ok'
    : String((settled.reason as { readonly code?: unknown }).code);

describe.skipIf(serverUrl === undefined)(
  'a live standing mandate is filed once under Repeatable Read',
  () => {
    let w: MandatesWorld;

    beforeAll(async () => {
      w = await buildMandatesWorld('mandrr');
    }, 120_000);

    afterAll(async () => {
      await w?.drop();
    });

    /** Wait, bounded, until a backend in this database is parked on a lock. */
    const blockedOnLock = async (deadline: number): Promise<boolean> => {
      const found = await w.controls.fixture.db.admin.execute(
        `select 1 from pg_stat_activity
          where datname = current_database() and state = 'active' and wait_event_type = 'Lock'`,
      );
      if (found.length > 0) return true;
      if (Date.now() > deadline) return false;
      await delay(25);
      return await blockedOnLock(deadline);
    };

    it('refuses the second of two identical filings whose snapshots predate the first commit', async () => {
      const label = `Posts for A under Repeatable Read ${String(Date.now())}`;
      const expiresAt = inDays(19);
      const one = postgres(w.controls.fixture.db.appUrl, { max: 1, onnotice: () => {} });
      const two = postgres(w.controls.fixture.db.appUrl, { max: 1, onnotice: () => {} });
      const insert = async (tx: postgres.TransactionSql): Promise<void> => {
        await tx.unsafe(
          `insert into public.standing_mandates
             (business_id, id, client_id, classes, refuses, ceiling_minor, currency, expires_at,
              label, authored_by_actor_id)
           values ((select public.app_business_id()), gen_random_uuid(), $1,
                   array['social.post'], false, 33000, 'AUD', $2, $3, $4)`,
          [w.clientA, expiresAt, label, w.admin.actorId],
        );
      };
      const firstSnapshot = gate(10_000);
      const secondSnapshot = gate(10_000);
      const written = gate(10_000);
      const held = gate(10_000);
      // Each transaction's first statement sets the business and fixes its snapshot.
      const first = one.begin('isolation level repeatable read', async (tx) => {
        await tx`select set_config('app.business_id', ${w.alpha}, true)`;
        firstSnapshot.open();
        await secondSnapshot.wait();
        await insert(tx);
        written.open();
        await held.wait();
      });
      const second = two.begin('isolation level repeatable read', async (tx) => {
        await tx`select set_config('app.business_id', ${w.alpha}, true)`;
        await firstSnapshot.wait();
        secondSnapshot.open();
        await written.wait();
        await insert(tx);
      });
      await written.wait();
      const waited = await blockedOnLock(Date.now() + 10_000);
      held.open();
      const settled = await Promise.allSettled([first, second]);
      await one.end();
      await two.end();
      expect(waited).toBe(true);
      expect(codeOf(settled[0])).toBe('ok');
      expect(codeOf(settled[1])).toMatch(/^(?:23505|40001)$/u);
      expect(
        await w.controls.count(
          `select count(*) as n from public.standing_mandates
            where label = $1 and revoked_at is null`,
          [label],
        ),
      ).toBe(1);
    }, 60_000);
  },
);
