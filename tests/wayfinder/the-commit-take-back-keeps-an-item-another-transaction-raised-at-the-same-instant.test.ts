// SPDX-License-Identifier: AGPL-3.0-only
//
// The take-back finds "this transaction's own" item by `raised_at = now()`,
// the transaction's start instant. Another transaction whose start instant is
// the same microsecond, and which raised and committed the ticket's item
// (a twin raise, or the command layer's), has an item the take-back cannot
// tell from its own: a transaction that lands and leaves the ticket deletes it.
// The instant is pinned here; under load two transactions can share it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { latch } from '../support/lock-wait-race.ts';
import {
  blockingLink,
  chartBlocked,
  decisionsOn,
  inBusinessTransaction,
  relink,
  unlink,
} from './frontier-decision-race.ts';
import { wayfinderWorld, type Decider, type WayfinderWorld } from './world.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'the take-back and the start instant',
  () => {
    let w: WayfinderWorld;
    let owner: Decider;

    beforeAll(async () => {
      w = await wayfinderWorld('frontierinstant', 'frontierinstant');
      owner = await w.decider('owner');
    }, 180_000);

    afterAll(async () => await w?.drop());

    it('an item another transaction committed at this transaction start instant survives its take-back', async () => {
      const { tickets } = await chartBlocked(w, owner, ['a']);
      const [a, g] = [tickets['a']!, tickets['g']!];
      const started = latch<string>();
      const proceed = latch();
      const moving = inBusinessTransaction(w, async (execute) => {
        const [row] = await execute<{ at: string }>('select now()::text as at');
        started.open(row!.at);
        await proceed.promise;
        const link = await blockingLink(execute, a, g);
        await unlink(execute, a, g);
        await relink(execute, link);
      });
      const instant = await started.promise;
      await w.db.admin.execute(
        `insert into public.inbox_items
         (business_id, id, recipient_person_id, subject_record_id, reason, fact_kind, fact_id,
          owed, raised_at)
       values ($1, gen_random_uuid(), $2, $3, 'decision', 'record', $3, true, $4::text::timestamptz)`,
        [w.business, owner.personId, g, instant],
      );
      proceed.open();
      await moving;
      expect(await decisionsOn(w, g)).toStrictEqual([
        { business: w.business, recipient: owner.personId, state: 'open' },
      ]);
    });
  },
);
