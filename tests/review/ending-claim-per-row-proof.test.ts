// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
  settleAccessEndings,
  type LoginProvider,
} from '../../packages/core-commands/src/commands/access-end.ts';
import { createFreshDatabase } from '../support/fresh-database.ts';
import { insertActor, insertBusiness, insertLogin, insertPerson } from '../identity/fixture.ts';

it('a bulk ending claim prevents overlapping provider calls after 30 seconds', async () => {
  const db = await createFreshDatabase({ part: 'solow008claim' });
  try {
    const business = await insertBusiness(db.app, 'sol-ending-claim');
    await db.app.withBusiness(business, async (tx) => {
      const person = await insertPerson(tx, 'Sol ending fixture');
      const actor = await insertActor(tx, person);
      for (let n = 0; n < 5; n += 1) {
        // oxlint-disable-next-line no-await-in-loop -- fixture writes share one transaction
        const login = await insertLogin(tx, randomUUID());
        // oxlint-disable-next-line no-await-in-loop -- fixture writes share one transaction
        await tx.query(
          `insert into public.access_endings (business_id, person_id, login_id, ended_by_actor_id)
           values ($1, $2, $3, $4)`,
          [business, person, login, actor],
        );
      }
    });
    const releaseFifth: (() => void)[] = [];
    const fifthStarted = new Promise<void>((resolve) => {
      releaseFifth.push(resolve);
    });
    let sessionCalls = 0;
    let maximumOverlap = 0;
    const active = new Map<string, number>();
    const providerCall = async (step: string, subject: string) => {
      const key = `${step}:${subject}`;
      const count = (active.get(key) ?? 0) + 1;
      active.set(key, count);
      maximumOverlap = Math.max(maximumOverlap, count);
      if (step === 'endSessions' && ++sessionCalls === 5) releaseFifth[0]?.();
      // Each call is below the production adapter's five-second limit.
      await delay(4_000);
      active.set(key, (active.get(key) ?? 1) - 1);
      return { ok: true, value: undefined } as const;
    };
    const provider: LoginProvider = {
      endSessions: (subject) => providerCall('endSessions', subject),
      deactivate: (subject) => providerCall('deactivate', subject),
    };
    const options = { sharedElsewhere: async () => false };
    // Use the production 30-second default, with no clock or database mutation.
    const first = settleAccessEndings(db.app, business, provider, options);
    await fifthStarted;
    const second = settleAccessEndings(db.app, business, provider, options);
    const reports = await Promise.all([first, second]);
    expect(reports[0]?.attempted).toBe(5);
    expect(maximumOverlap, 'one ending must never have two provider calls in flight').toBe(1);
  } finally {
    await db.drop();
  }
}, 90_000);
