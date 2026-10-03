// SPDX-License-Identifier: AGPL-3.0-only
//
// SOLOW-D D3S1: an access ending waiting for its login's subject lock
// (`second-factor-subject:<digest>`). The lock is installation-wide, so here
// another business holds it, as a settle, factor reset or enrolment on the
// same shared login can.
//
// A retry whose 30-second claim lapsed while it waited, with a second retry
// claiming the row meanwhile, reads the stamps again under the lock, so no
// provider step runs twice. And the wait is bounded: an ending that cannot
// take the lock in time gives up unstamped, stays owed, and the next pass
// settles it.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  settleAccessEndings,
  type LoginProvider,
} from '../../packages/core-commands/src/commands/access-end.ts';
import { lockLoginSubject } from '../../packages/core-records/src/index.ts';
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

/** Another business's transaction holding the subject lock until released. */
async function holdSubjectLock(subject: string) {
  const bravo = await insertBusiness(wide, `bravo-${randomUUID()}`);
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let taken!: () => void;
  const held = new Promise<void>((resolve) => {
    taken = resolve;
  });
  const done = wide.withBusiness(bravo, async (tx) => {
    await lockLoginSubject(tx, subject);
    taken();
    await released;
  });
  await held;
  return {
    release: async () => {
      release();
      await done;
    },
  };
}

/** A provider that answers every call done and notes each one. */
function countingProvider() {
  const calls: string[] = [];
  const provider: LoginProvider = {
    endSessions: async () => {
      calls.push('sessions');
      return await Promise.resolve({ ok: true, value: undefined });
    },
    deactivate: async () => {
      calls.push('login');
      return await Promise.resolve({ ok: true, value: undefined });
    },
  };
  return { provider, calls };
}

async function stamps(alpha: string) {
  return await db.admin.execute<{ readonly sessions: boolean; readonly login: boolean }>(
    `select sessions_ended_at is not null as sessions, login_deactivated_at is not null as login
       from public.access_endings where business_id = $1`,
    [alpha],
  );
}

const live = databaseUrlFromEnvironment() !== undefined;
const notShared = async (): Promise<boolean> => await Promise.resolve(false);

beforeAll(async () => {
  if (!live) return;
  db = await createFreshDatabase({ part: 'solowd3locks' });
  wide = connect(db.appUrl, { max: 6 });
});

afterAll(async () => {
  await wide?.close();
  await db?.drop();
});

it.skipIf(!live)(
  'a retry whose claim lapsed while it waited for the login lock never asks a step again',
  async () => {
    const { alpha, subject } = await owedEnding();
    const holder = await holdSubjectLock(subject);
    const { provider, calls } = countingProvider();
    const options = { sharedElsewhere: notShared, claimSeconds: 1 };
    let first: ReturnType<typeof settleAccessEndings> | undefined;
    let second: ReturnType<typeof settleAccessEndings> | undefined;
    try {
      first = settleAccessEndings(wide, alpha, provider, options);
      // The first retry has claimed the ending and waits on the lock past its claim.
      await delay(1600);
      second = settleAccessEndings(wide, alpha, provider, options);
      // The second claims the lapsed ending and waits on the lock too.
      await delay(600);
    } finally {
      await holder.release();
    }
    const reports = await Promise.all([first, second]);
    expect(
      reports.map((report) => report?.attempted),
      'each retry claimed the ending',
    ).toEqual([1, 1]);
    expect(calls, 'each provider step asked exactly once').toEqual(['sessions', 'login']);
    expect(await stamps(alpha)).toEqual([{ sessions: true, login: true }]);
  },
  20_000,
);

it.skipIf(!live)(
  'an ending that cannot take the login lock in time stays owed, and the next pass settles it',
  async () => {
    const { alpha, subject } = await owedEnding();
    const holder = await holdSubjectLock(subject);
    const { provider, calls } = countingProvider();
    // Not a literal, so it reads the same before the bound existed.
    const bounded = { sharedElsewhere: notShared, lockWaitMs: 500 };
    let waiting: ReturnType<typeof settleAccessEndings> | undefined;
    try {
      waiting = settleAccessEndings(wide, alpha, provider, bounded);
      const gaveUp = await Promise.race([
        waiting,
        delay(4000).then(() => 'still waiting' as const),
      ]);
      expect(gaveUp, 'gave up within the bound, the ending owed').toEqual({
        attempted: 1,
        settled: 0,
        owed: 1,
        faults: 0,
      });
      expect(calls, 'nothing asked without the lock').toEqual([]);
      expect(await stamps(alpha)).toEqual([{ sessions: false, login: false }]);
    } finally {
      await holder.release();
      await waiting?.catch(() => null);
    }
    // By the next pass the claim has lapsed: `claimSeconds: 0` stands in for that.
    const next = await settleAccessEndings(wide, alpha, provider, {
      sharedElsewhere: notShared,
      claimSeconds: 0,
    });
    expect(next).toEqual({ attempted: 1, settled: 1, owed: 0, faults: 0 });
    expect(calls).toEqual(['sessions', 'login']);
    expect(await stamps(alpha)).toEqual([{ sessions: true, login: true }]);
  },
  20_000,
);
