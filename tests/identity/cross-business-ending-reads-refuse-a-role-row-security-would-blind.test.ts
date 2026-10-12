// SPDX-License-Identifier: AGPL-3.0-only
//
// The endings loop's reads across businesses (whether a login is live
// elsewhere, and which businesses owe a step) run with row security off. On a
// connection whose role does not bypass row security, the application's own
// login (a member of ops_astro_app: read on the identity and endings tables
// and execute on `app_business_id`), each is refused with Postgres's
// row-security error, 42501, instead of answering "not live" and "nothing
// owed" from the rows its policies leave it.

import { afterAll, beforeAll, expect, it } from 'vitest';
import { retryAccessEndings } from '../../apps/endings/pass.ts';
import type { LoginProvider } from '../../packages/core-commands/src/commands/access-end.ts';
import { loginLiveElsewhere } from '../../packages/core-records/src/index.ts';
import {
  connectAsAdmin,
  type AdminConnection,
} from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { sharedSubject, type SharedSubject } from './live-elsewhere-world.ts';

const serverUrl = databaseUrlFromEnvironment();
let db: FreshDatabase;
let blinded: AdminConnection;
let pair: SharedSubject;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'rls_blind' });
  blinded = connectAsAdmin(db.appUrl);
  pair = await sharedSubject(db);
}, 120_000);

afterAll(async () => {
  await blinded?.close();
  await db?.drop();
});

const ROW_SECURITY = { code: '42501' };

it.skipIf(serverUrl === undefined)(
  'whether a login is live elsewhere is refused on a role row security would blind',
  async () => {
    expect(await loginLiveElsewhere(db.admin, pair.subject, pair.alpha)).toBe(true);
    await expect(loginLiveElsewhere(blinded, pair.subject, pair.alpha)).rejects.toMatchObject(
      ROW_SECURITY,
    );
  },
);

it.skipIf(serverUrl === undefined)(
  'the endings backlog is refused on a role row security would blind',
  async () => {
    const nothingSent: LoginProvider = {
      endSessions: async () => await Promise.resolve({ ok: false, fault: 'unreachable' }),
      deactivate: async () => await Promise.resolve({ ok: false, fault: 'unreachable' }),
    };
    await db.app.withBusiness(pair.alpha, async (tx) => {
      await tx.query(
        `insert into public.access_endings (business_id, person_id, login_id, ended_by_actor_id)
         select pl.business_id, pl.person_id, pl.login_id, pl.linked_by_actor_id
           from public.person_logins pl where pl.business_id = $1 and pl.login_id = $2`,
        [pair.alpha, pair.alphaLogin],
      );
    });
    await expect(retryAccessEndings(blinded, db.app, nothingSent)).rejects.toMatchObject(
      ROW_SECURITY,
    );
  },
);
