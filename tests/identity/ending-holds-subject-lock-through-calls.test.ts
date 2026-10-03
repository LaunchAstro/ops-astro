// SPDX-License-Identifier: AGPL-3.0-only
//
// SOLOW-D D3 (Sol OW-028.2): an access ending holds its login's subject lock
// (`second-factor-subject:<digest>`) from the shared-login check through its
// provider calls and their stamp. Another business's transaction that takes
// the same lock first, as any path mapping a login into a business must, waits
// until the ending is stamped, so it can never commit a link between the check
// and the ban. Here that transaction is a factor record step in bravo, the
// lock's existing taker (`liveFactor` with `lock`).

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  settleAccessEndings,
  type LoginProvider,
} from '../../packages/core-commands/src/commands/access-end.ts';
import { liveFactor } from '../../packages/core-records/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from './fixture.ts';

let db: FreshDatabase;
let wide: Database;

/** One ending owed in a business of its own, for a fresh provider subject. */
async function owedEnding(): Promise<{ readonly alpha: string; readonly subject: string }> {
  const alpha = await insertBusiness(wide, `alpha-${randomUUID()}`);
  const subject = randomUUID();
  await wide.withBusiness(alpha, async (tx) => {
    const person = await insertPerson(tx, 'Ended person');
    const actor = await insertActor(tx, person);
    const login = await insertLogin(tx, subject);
    await insertMembership(tx, person, false);
    await insertMapping(tx, login, person, actor);
    await tx.query(
      `insert into public.access_endings (business_id, person_id, login_id, ended_by_actor_id)
       values ($1, $2, $3, $4)`,
      [alpha, person, login, actor],
    );
  });
  return { alpha, subject };
}

/**
 * A provider whose first call starts bravo's transaction on the subject lock
 * and whose every call notes whether bravo held that lock while it ran.
 */
function lockWatchingProvider(bravo: string) {
  const seen = { queued: Promise.resolve(), bravoHeld: false, heldDuringCalls: [] as boolean[] };
  const provider: LoginProvider = {
    endSessions: async (asked) => {
      seen.queued = wide.withBusiness(bravo, async (tx) => {
        await liveFactor(tx, randomUUID(), { lock: asked });
        seen.bravoHeld = true;
      });
      // Long enough for an unblocked transaction to take the lock.
      await delay(500);
      seen.heldDuringCalls.push(seen.bravoHeld);
      return { ok: true, value: undefined };
    },
    deactivate: async () => {
      await delay(200);
      seen.heldDuringCalls.push(seen.bravoHeld);
      return { ok: true, value: undefined };
    },
  };
  return { provider, seen };
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'an access ending and its login subject lock',
  () => {
    beforeAll(async () => {
      db = await createFreshDatabase({ part: 'solowd3lock' });
      wide = connect(db.appUrl, { max: 4 });
    });
    afterAll(async () => {
      await wide?.close();
      await db?.drop();
    });

    it('another business taking the subject lock waits until the ending is stamped', async () => {
      const { alpha } = await owedEnding();
      const bravo = await insertBusiness(wide, `bravo-${randomUUID()}`);
      const { provider, seen } = lockWatchingProvider(bravo);
      const report = await settleAccessEndings(wide, alpha, provider, {
        sharedElsewhere: async () => await Promise.resolve(false),
      });
      await seen.queued;
      expect(seen.heldDuringCalls, 'bravo never held the lock while a call was in flight').toEqual([
        false,
        false,
      ]);
      expect(seen.bravoHeld, 'bravo took the lock once the ending was stamped').toBe(true);
      expect(report).toMatchObject({ attempted: 1, settled: 1, owed: 0 });
      const stamped = await db.admin.execute<{ readonly done: boolean }>(
        `select sessions_ended_at is not null and login_deactivated_at is not null as done
         from public.access_endings where business_id = $1`,
        [alpha],
      );
      expect(stamped).toEqual([{ done: true }]);
    });
  },
);
