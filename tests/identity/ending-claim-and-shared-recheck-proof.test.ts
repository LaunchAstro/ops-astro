// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createGoTrueLogins } from '../../apps/api/auth/logins.ts';
import {
  settleAccessEndings,
  type LoginProvider,
} from '../../packages/core-commands/src/commands/access-end.ts';
import { loginLiveElsewhere } from '../../packages/core-records/src/identity/shared-login.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
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

beforeAll(async () => {
  db = await createFreshDatabase({ part: 'solow028' });
  wide = connect(db.appUrl, { max: 4 });
});

afterAll(async () => {
  await wide?.close();
  await db?.drop();
});

async function owed(business: string, subject = randomUUID()) {
  await wide.withBusiness(business, async (tx) => {
    const person = await insertPerson(tx, 'Ended person');
    const actor = await insertActor(tx, person);
    const login = await insertLogin(tx, subject);
    await insertMembership(tx, person, false);
    await insertMapping(tx, login, person, actor);
    await tx.query(
      `insert into public.access_endings
         (business_id, person_id, login_id, ended_by_actor_id)
       values ($1, $2, $3, $4)`,
      [business, person, login, actor],
    );
  });
  return subject;
}

it('a batch keeps each ending claimed until its provider calls finish', async () => {
  const business = await insertBusiness(wide, `lease-${randomUUID()}`);
  await Promise.all(Array.from({ length: 4 }, () => owed(business)));
  const calls: string[] = [];
  let fast = false;
  let started!: () => void;
  const firstCall = new Promise<void>((resolve) => {
    started = resolve;
  });
  const provider: LoginProvider = {
    endSessions: async (subject) => {
      calls.push(`sessions:${subject}`);
      started();
      if (!fast) await delay(4500);
      return { ok: true, value: undefined };
    },
    deactivate: async (subject) => {
      calls.push(`login:${subject}`);
      if (!fast) await delay(4500);
      return { ok: true, value: undefined };
    },
  };
  const options = { sharedElsewhere: async () => false };
  const first = settleAccessEndings(wide, business, provider, options);
  await firstCall;
  // Every individual provider call finishes inside the adapter's five seconds.
  // Three endings take 27 seconds; the fourth is in flight when the lease expires.
  await delay(30_250);
  fast = true;
  try {
    const retry = await settleAccessEndings(wide, business, provider, options);
    await first;
    expect(calls, 'four endings have eight provider steps, each asked once').toHaveLength(8);
    expect(new Set(calls).size, 'each provider step was asked once').toBe(calls.length);
    expect(retry.attempted, 'a live worker still owns the fourth ending').toBe(0);
  } finally {
    await first;
  }
}, 45_000);

it('business to business separation survives a login linked after the shared check', async () => {
  const alpha = await insertBusiness(wide, `alpha-${randomUUID()}`);
  const bravo = await insertBusiness(wide, `bravo-${randomUUID()}`);
  const subject = await owed(alpha);
  const calls: string[] = [];
  const liveAtBan: boolean[] = [];
  let initiallyShared: boolean | undefined;
  const provider = createGoTrueLogins({
    baseUrl: 'http://127.0.0.1:9/auth/v1',
    adminKey: async () => 'sol-proof-stand-in-key',
    fetch: async (url, init) => {
      liveAtBan.push(await loginLiveElsewhere(db.admin, subject, alpha));
      calls.push(`${String(url)} ${String(init?.body)}`);
      return Response.json({ id: subject, banned_until: '2999-01-01T00:00:00Z' });
    },
  });
  await settleAccessEndings(wide, alpha, provider, {
    sharedElsewhere: async (user) => {
      const shared = await loginLiveElsewhere(db.admin, user, alpha);
      initiallyShared = shared;
      // An independent tenant transaction links this provider login after the
      // worker's read, before it acts. No row or subject lock prevents the commit.
      await wide.withBusiness(bravo, async (tx) => {
        const person = await insertPerson(tx, 'Still active in bravo');
        const actor = await insertActor(tx, person);
        await insertMembership(tx, person);
        await insertMapping(tx, await insertLogin(tx, user), person, actor);
      });
      return shared;
    },
  });
  expect(initiallyShared).toBe(false);
  expect(await loginLiveElsewhere(db.admin, subject, alpha)).toBe(true);
  expect(liveAtBan.every(Boolean)).toBe(true);
  expect(calls, 'the provider ban would also end bravo access').toEqual([]);
});
