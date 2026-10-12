// SPDX-License-Identifier: AGPL-3.0-only
//
// An ending's provider steps are judged shared or not under the login's
// subject lock, every time. Alpha's pass asks first, before the lock, and
// hears that the login is live in bravo; bravo then ends that person's access
// and commits before alpha's pass takes the lock. The answer under the lock is
// no, so alpha's steps are sent and stamped done, not stamped skipped as
// shared on the stale first answer.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  settleAccessEndings,
  type LoginProvider,
} from '../../packages/core-commands/src/commands/access-end.ts';
import { loginLiveElsewhere } from '../../packages/core-records/src/index.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { endInBravo, sharedSubject } from './live-elsewhere-world.ts';

const serverUrl = databaseUrlFromEnvironment();
let db: FreshDatabase;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'stale_shared' });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

it.skipIf(serverUrl === undefined)(
  'an ending first judged shared is sent once the other business ends that login before the lock',
  async () => {
    const pair = await sharedSubject(db);
    const ending = randomUUID();
    await db.app.withBusiness(pair.alpha, async (tx) => {
      await tx.query(
        `insert into public.access_endings (business_id, id, person_id, login_id, ended_by_actor_id)
         select pl.business_id, $3, pl.person_id, pl.login_id, pl.linked_by_actor_id
           from public.person_logins pl where pl.business_id = $1 and pl.login_id = $2`,
        [pair.alpha, pair.alphaLogin, ending],
      );
    });
    const calls: string[] = [];
    const provider: LoginProvider = {
      endSessions: async (subject) => {
        calls.push(`sessions:${subject}`);
        return await Promise.resolve({ ok: true, value: undefined });
      },
      deactivate: async (subject) => {
        calls.push(`login:${subject}`);
        return await Promise.resolve({ ok: true, value: undefined });
      },
    };
    let first: boolean | undefined;
    const report = await settleAccessEndings(db.app, pair.alpha, provider, {
      sharedElsewhere: async (subject) => {
        first = await loginLiveElsewhere(db.admin, subject, pair.alpha);
        await endInBravo(db, pair);
        return first;
      },
    });
    expect(first, 'bravo held the login live when alpha first asked').toBe(true);
    expect(calls).toEqual([`sessions:${pair.subject}`, `login:${pair.subject}`]);
    expect(report).toMatchObject({ settled: 1, owed: 0, faults: 0 });
    const [row] = await db.admin.execute(
      'select provider_steps_skipped as skipped from public.access_endings where id = $1',
      [ending],
    );
    expect(row).toEqual({ skipped: null });
  },
  60_000,
);
