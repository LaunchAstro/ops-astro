// SPDX-License-Identifier: AGPL-3.0-only
//
// A reset ends every session the login had, in every business, from `begin`
// on: the window `begin` opens does the ending, so a page that wrote the
// password and never called `changed` (a crash, a lost answer) leaves no old
// session usable. Once `changed` settles the window, a new sign-in is served.
// Against the pinned GoTrue (`reset-world.ts`).

import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { authorised, post } from './fixture.ts';
import {
  alpha,
  api,
  begin,
  bravo,
  changed,
  db,
  door,
  linkMinted,
  linkSession,
  personIn,
  signIn,
  sessionOf,
  providerReady,
  writePassword,
  useResetWorld,
} from './reset-world.ts';

const withProvider = it.skipIf(!providerReady);

useResetWorld('rstend');

const NEW_PASSWORD = 'a-new-password-for-reset';

withProvider(
  'a reset retires sessions seen only in another business and leaves another login live',
  async () => {
    const person = await personIn(alpha, bravo);
    const other = await personIn(alpha, bravo);
    const old = await signIn(person);
    const unrelated = await signIn(other);
    expect(await door(old, 'bravo')).toBe('served');
    expect(await door(unrelated, 'alpha')).toBe('served');
    expect(await door(unrelated, 'bravo')).toBe('served');
    await linkMinted(person);
    const recovery = await linkSession(person);
    expect((await begin(recovery)).status).toBe(200);
    await db.app.withBusiness(
      alpha,
      async (tx) =>
        await tx.query(
          `select ops.recovery_sessions_end(reset_id) from ops.recovery_resets
          where session_digest = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
          [sessionOf(recovery)],
        ),
    );
    expect(await durablyEnded(old)).toBe(false);
    expect((await changed(recovery, NEW_PASSWORD)).status).toBe(200);
    expect(await durablyEnded(old)).toBe(true);
    await delay(1100);
    const fresh = await signIn(person, NEW_PASSWORD);
    const businesses: readonly ('alpha' | 'bravo')[] = ['alpha', 'bravo'];
    await Promise.all(
      businesses.map(async (business) => {
        await onlyFreshSession(fresh, business);
        expect(await door(unrelated, business)).toBe('served');
      }),
    );
  },
  60_000,
);

withProvider(
  'a session signed in before begin is refused in both businesses after the write, with no changed call',
  async () => {
    const person = await personIn(alpha, bravo);
    const old = await signIn(person);
    expect(await door(old, 'alpha')).toBe('served');
    expect(await door(old, 'bravo')).toBe('served');
    await linkMinted(person);
    const recovery = await linkSession(person);
    expect((await begin(recovery)).status).toBe(200);
    expect((await writePassword(recovery, NEW_PASSWORD)).status).toBe(200);
    // No `changed`: the page crashed after the provider's write.
    expect(await door(old, 'alpha')).toBe('AUTH_SESSION_EXPIRED');
    expect(await door(old, 'bravo')).toBe('AUTH_SESSION_EXPIRED');
  },
  60_000,
);

withProvider(
  'a sign-in after the window settles is served, and the old session stays refused',
  async () => {
    const person = await personIn(alpha, bravo);
    const old = await signIn(person);
    await linkMinted(person);
    const recovery = await linkSession(person);
    expect((await begin(recovery)).status).toBe(200);
    expect((await changed(recovery, NEW_PASSWORD)).status).toBe(200);
    // The provider stamps a sign-in in whole seconds; the next one is past the settle.
    await delay(1100);
    const fresh = await signIn(person, NEW_PASSWORD);
    expect(await door(fresh, 'alpha')).toBe('served');
    expect(await door(fresh, 'bravo')).toBe('served');
    expect(await door(old, 'alpha')).toBe('AUTH_SESSION_EXPIRED');
  },
  60_000,
);

withProvider(
  'a later settled reset stops asking the provider about an earlier unsettled window',
  async () => {
    const person = await personIn(alpha);
    await linkMinted(person);
    expect((await begin(await linkSession(person))).status).toBe(200);
    // The first window past its bound, its settle-once trigger set aside.
    await db.admin.execute(
      `update ops.subject_resets s set open_until = clock_timestamp() - interval '1 minute'
         from (select set_config('session_replication_role', 'replica', true)) r
        where s.subject_digest = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
      [person.subject],
    );
    expect(await writeOpen(person.subject)).toBe(true);
    await linkMinted(person);
    const second = await linkSession(person);
    expect((await begin(second)).status).toBe(200);
    expect((await changed(second, NEW_PASSWORD)).status).toBe(200);
    expect(await writeOpen(person.subject)).toBe(false);
    await delay(1100);
    expect(await door(await signIn(person, NEW_PASSWORD), 'alpha')).toBe('served');
  },
  60_000,
);

/** `ops.reset_write_open` for a session of the login signed in now. */
async function writeOpen(subject: string): Promise<boolean> {
  const [row] = await db.admin.execute<{ readonly open: boolean }>(
    'select ops.reset_write_open($1, extract(epoch from clock_timestamp())::bigint) as open',
    [subject],
  );
  return row?.open === true;
}

async function durablyEnded(token: string): Promise<boolean> {
  const [row] = await db.admin.execute<{ readonly ended: boolean }>(
    `select exists (select 1 from ops.ended_provider_sessions where session_id = $1::uuid) as ended`,
    [sessionOf(token)],
  );
  return row?.ended === true;
}

async function onlyFreshSession(token: string, business: 'alpha' | 'bravo'): Promise<void> {
  const answer = await post(api, `/api/b/${business}/account/sessions/list`, {}, authorised(token));
  expect(answer.status).toBe(200);
  expect(answer.body['sessions']).toHaveLength(1);
  expect(answer.body).toMatchObject({ sessions: [{ sessionId: sessionOf(token), current: true }] });
}

withProvider(
  'a settled recovery session cannot leave a provider-deleted session authorised in either business',
  async () => {
    const person = await personIn(alpha, bravo);
    await linkMinted(person);
    const recovery = await linkSession(person);
    expect((await begin(recovery)).status).toBe(200);
    expect((await changed(recovery, 'sol-first-password-1656')).status).toBe(200);
    await delay(1100);
    const fresh = await signIn(person, 'sol-first-password-1656');
    expect(await door(fresh, 'alpha')).toBe('served');
    expect(await door(fresh, 'bravo')).toBe('served');
    // A caller can retain the recovery bearer instead of performing browser
    // logout: `changed` signed its session out at the provider before the
    // settle, so the kept bearer writes nothing and deletes no later session.
    const kept = await fetch(`${process.env['RESET_AUTH_URL']}/user`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${recovery}`, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'sol-second-password-1656' }),
    });
    expect(kept.status).toBe(403);
    expect(((await kept.json()) as { error_code: string }).error_code).toBe('session_not_found');
    const live = await fetch(`${process.env['RESET_AUTH_URL']}/user`, {
      headers: { authorization: `Bearer ${fresh}` },
    });
    expect(live.status).toBe(200);
    expect(await signIn(person, 'sol-first-password-1656')).toEqual(expect.any(String));
    expect(await Promise.all([door(fresh, 'alpha'), door(fresh, 'bravo')])).toStrictEqual([
      'served',
      'served',
    ]);
  },
  120_000,
);
