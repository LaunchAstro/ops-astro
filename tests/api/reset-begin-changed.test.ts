// SPDX-License-Identifier: AGPL-3.0-only
//
// Password reset on the provider's one-time recovery session, against the
// pinned GoTrue (`reset-world.ts`). `begin` takes only a recovery session
// minted from a link the service mailed, still the provider's latest, and
// opens one window per session; `changed` writes the password on that session
// and settles the window, auditing once, only on that write's own 200.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { grantTo } from '../commands/fixture.ts';
import {
  alpha,
  auditsOf,
  begin,
  changed,
  db,
  door,
  factorVerified,
  issuer,
  linkMinted,
  linkSession,
  personIn,
  signIn,
  windowsOf,
  providerReady,
  useResetWorld,
} from './reset-world.ts';

const withProvider = it.skipIf(!providerReady);

useResetWorld('rstbc');

const NEW_PASSWORD = 'a-new-password-for-reset';

describe('begin', () => {
  withProvider('refuses a password sign-in, opening no window', async () => {
    const person = await personIn(alpha);
    await linkMinted(person);
    const token = await signIn(person);
    const answer = await begin(token);
    expect(answer).toMatchObject({ status: 401, body: { code: 'RESET_LINK_INVALID' } });
    expect(await windowsOf(token)).toStrictEqual([]);
  });

  withProvider('refuses a sign-in link session when no recovery link was minted', async () => {
    const person = await personIn(alpha);
    const token = await linkSession(person, 'magiclink');
    const answer = await begin(token);
    expect(answer).toMatchObject({ status: 401, body: { code: 'RESET_LINK_INVALID' } });
    expect(await windowsOf(token)).toStrictEqual([]);
  });

  withProvider(
    'refuses a sign-in link minted after the recovery link, consuming nothing',
    async () => {
      const person = await personIn(alpha);
      await linkMinted(person);
      const token = await linkSession(person, 'magiclink');
      const answer = await begin(token);
      expect(answer).toMatchObject({ status: 401, body: { code: 'RESET_LINK_INVALID' } });
      expect(await windowsOf(token)).toStrictEqual([]);
      expect(await linksConsumed(person.subject)).toStrictEqual([false]);
    },
  );

  withProvider('opens one window for a recovery session from a minted link', async () => {
    const person = await personIn(alpha);
    await linkMinted(person);
    const token = await linkSession(person);
    const answer = await begin(token);
    expect(answer).toMatchObject({ status: 200, body: {} });
    expect(await windowsOf(token)).toStrictEqual([{ settled: false, reset_settled: false }]);
    expect(await linksConsumed(person.subject)).toStrictEqual([true]);
  });
});

async function linksConsumed(subject: string): Promise<readonly boolean[]> {
  const links = await db.admin.execute<{ readonly consumed: boolean }>(
    `select consumed_at is not null as consumed from ops.recovery_links
      where subject_digest = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
    [subject],
  );
  return links.map(({ consumed }) => consumed);
}

describe('begin again, and for a login with an authenticator', () => {
  withProvider('answers a second begin on the same session with the same window', async () => {
    const person = await personIn(alpha);
    await linkMinted(person);
    const token = await linkSession(person);
    expect((await begin(token)).status).toBe(200);
    expect((await begin(token)).status).toBe(200);
    expect(await windowsOf(token)).toHaveLength(1);
    const windows = await db.admin.execute(
      `select 1 from ops.subject_resets
        where subject_digest = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
      [person.subject],
    );
    expect(windows).toHaveLength(1);
  });

  withProvider('refuses a login with an authenticator as needing support', async () => {
    const person = await personIn(alpha);
    await factorVerified(person, alpha);
    await linkMinted(person);
    const token = await linkSession(person);
    const answer = await begin(token);
    expect(answer).toMatchObject({ status: 403, body: { code: 'RESET_NEEDS_SUPPORT' } });
    expect(await windowsOf(token)).toStrictEqual([]);
  });
});

describe('changed', () => {
  withProvider('confirms nothing without a password, the window left open', async () => {
    const person = await personIn(alpha);
    await linkMinted(person);
    const token = await linkSession(person);
    expect((await begin(token)).status).toBe(200);
    const answer = await changed(token);
    expect(answer).toMatchObject({ status: 409, body: { code: 'RESET_NOT_CONFIRMED' } });
    expect(await windowsOf(token)).toStrictEqual([{ settled: false, reset_settled: false }]);
    expect(await auditsOf(person, alpha)).toStrictEqual([]);
  });

  withProvider('is not confirmed by a write of the login metadata', async () => {
    const person = await personIn(alpha);
    await linkMinted(person);
    const token = await linkSession(person);
    expect((await begin(token)).status).toBe(200);
    const write = await fetch(`${issuer ?? ''}/user`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ data: { note: 'the password is unchanged' } }),
    });
    expect(write.status).toBe(200);
    await write.body?.cancel();
    expect(await signIn(person)).toBeTruthy();
    const answer = await changed(token);
    expect(answer).toMatchObject({ status: 409, body: { code: 'RESET_NOT_CONFIRMED' } });
    expect(await windowsOf(token)).toStrictEqual([{ settled: false, reset_settled: false }]);
    expect(await auditsOf(person, alpha)).toStrictEqual([]);
  });

  withProvider('writes the password, settles the window and audits once', async () => {
    const person = await personIn(alpha);
    await linkMinted(person);
    const token = await linkSession(person);
    expect((await begin(token)).status).toBe(200);
    const answer = await changed(token, NEW_PASSWORD);
    expect(answer).toMatchObject({ status: 200, body: {} });
    expect(await windowsOf(token)).toStrictEqual([{ settled: true, reset_settled: true }]);
    expect(await signIn(person, NEW_PASSWORD)).toBeTruthy();
    await expect(signIn(person)).rejects.toThrow();
    const audits = await auditsOf(person, alpha);
    expect(audits).toHaveLength(1);
    // Digests only: no password, no token, no session id.
    for (const secret of [NEW_PASSWORD, person.password, token]) {
      expect(audits[0]).not.toContain(secret);
    }
  });
});

describe('changed, refused or repeated', () => {
  withProvider('asks again for a password the provider refuses, the window kept', async () => {
    const person = await personIn(alpha);
    await linkMinted(person);
    const token = await linkSession(person);
    expect((await begin(token)).status).toBe(200);
    const answer = await changed(token, 'short');
    expect(answer).toMatchObject({ status: 422, body: { code: 'RESET_PASSWORD_REFUSED' } });
    expect(await windowsOf(token)).toStrictEqual([{ settled: false, reset_settled: false }]);
    expect((await changed(token, NEW_PASSWORD)).status).toBe(200);
  });

  withProvider('writes nothing once the window is too near its bound', async () => {
    const person = await personIn(alpha);
    await linkMinted(person);
    const token = await linkSession(person);
    expect((await begin(token)).status).toBe(200);
    // The bound brought inside the write's room, its settle-once trigger set aside.
    await db.admin.execute(
      `update ops.subject_resets s set open_until = clock_timestamp() + interval '10 seconds'
         from (select set_config('session_replication_role', 'replica', true)) r
        where s.subject_digest = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
      [person.subject],
    );
    const answer = await changed(token, NEW_PASSWORD);
    expect(answer).toMatchObject({ status: 401, body: { code: 'RESET_LINK_INVALID' } });
    expect(await signIn(person)).toBeTruthy();
    expect(await windowsOf(token)).toStrictEqual([{ settled: false, reset_settled: false }]);
  });

  withProvider('adds no audit on a retry, one after the other or at once', async () => {
    const person = await personIn(alpha);
    await linkMinted(person);
    const token = await linkSession(person);
    expect((await begin(token)).status).toBe(200);
    const together = await Promise.all([
      changed(token, NEW_PASSWORD),
      changed(token, NEW_PASSWORD),
    ]);
    expect(together.filter((answer) => answer.status === 200).length).toBeGreaterThan(0);
    const again = await changed(token, `${NEW_PASSWORD}-again`);
    expect(again).toMatchObject({ status: 401, body: { code: 'RESET_LINK_INVALID' } });
    expect(await auditsOf(person, alpha)).toHaveLength(1);
    expect(await signIn(person, NEW_PASSWORD)).toBeTruthy();
    // A settled window is not opened again by a later begin.
    expect((await begin(token)).body).toStrictEqual({ code: 'RESET_LINK_INVALID' });
    expect(await windowsOf(token)).toStrictEqual([{ settled: true, reset_settled: true }]);
  });
});

withProvider(
  'an admitted external client with a live share can reset their own password',
  async () => {
    const person = await personIn(alpha);
    const personId = person.people.get(alpha)!;
    await db.app.withBusiness(alpha, async (tx) => {
      const [actor] = await tx.query<{ id: string }>(
        'select id::text from public.actors where business_id = $1 and person_id = $2',
        [alpha, personId],
      );
      await grantTo(
        tx,
        {
          personId,
          actorId: actor!.id,
          presented: { provider: 'supabase', subject: person.subject },
        },
        'read',
        { kind: 'record', id: randomUUID() },
      );
      await tx.query(
        'update public.memberships set active = false, ended_at = clock_timestamp() where business_id = $1 and person_id = $2',
        [alpha, personId],
      );
    });
    expect(await door(await signIn(person), 'alpha')).toBe('served');
    await linkMinted(person);
    const recovery = await linkSession(person);
    expect(await begin(recovery)).toStrictEqual({ status: 200, body: {} });
  },
  120_000,
);
