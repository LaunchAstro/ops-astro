// SPDX-License-Identifier: AGPL-3.0-only
//
// Password reset on the provider's one-time recovery session, against the
// pinned GoTrue (`reset-world.ts`). `begin` takes only a recovery session
// minted from a link the service mailed, and opens one window per session;
// `changed` settles that window, and audits once, only after the provider
// shows the password written since the window opened.

import { describe, expect, it } from 'vitest';
import {
  alpha,
  auditsIn,
  begin,
  changed,
  db,
  factorVerified,
  linkMinted,
  linkSession,
  personIn,
  signIn,
  windowsOf,
  providerReady,
  writePassword,
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

  withProvider('opens one window for a recovery session from a minted link', async () => {
    const person = await personIn(alpha);
    await linkMinted(person);
    const token = await linkSession(person);
    const answer = await begin(token);
    expect(answer).toMatchObject({ status: 200, body: {} });
    expect(await windowsOf(token)).toStrictEqual([{ settled: false, reset_settled: false }]);
    const links = await db.admin.execute<{ readonly consumed: boolean }>(
      `select consumed_at is not null as consumed from ops.recovery_links
        where subject_digest = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
      [person.subject],
    );
    expect(links).toStrictEqual([{ consumed: true }]);
  });
});

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
  withProvider('is not confirmed before the password is written', async () => {
    const person = await personIn(alpha);
    await linkMinted(person);
    const token = await linkSession(person);
    expect((await begin(token)).status).toBe(200);
    const answer = await changed(token);
    expect(answer).toMatchObject({ status: 409, body: { code: 'RESET_NOT_CONFIRMED' } });
    expect(await windowsOf(token)).toStrictEqual([{ settled: false, reset_settled: false }]);
    expect(await auditsIn(alpha)).toStrictEqual([]);
  });

  withProvider('settles the window and audits once after the password is written', async () => {
    const person = await personIn(alpha);
    await linkMinted(person);
    const token = await linkSession(person);
    expect((await begin(token)).status).toBe(200);
    expect((await writePassword(token, NEW_PASSWORD)).status).toBe(200);
    const answer = await changed(token);
    expect(answer).toMatchObject({ status: 200, body: {} });
    expect(await windowsOf(token)).toStrictEqual([{ settled: true, reset_settled: true }]);
    const audits = await auditsIn(alpha);
    expect(audits).toHaveLength(1);
    // Digests only: no password, no token, no session id.
    for (const secret of [NEW_PASSWORD, person.password, token]) {
      expect(audits[0]?.row).not.toContain(secret);
    }
  });

  withProvider('adds no audit on a retry, one after the other or at once', async () => {
    const person = await personIn(alpha);
    await linkMinted(person);
    const token = await linkSession(person);
    expect((await begin(token)).status).toBe(200);
    expect((await writePassword(token, NEW_PASSWORD)).status).toBe(200);
    const together = await Promise.all([changed(token), changed(token)]);
    expect(together.filter((answer) => answer.status === 200).length).toBeGreaterThan(0);
    const again = await changed(token);
    expect(again.status).not.toBe(200);
    expect(await auditsIn(alpha)).toHaveLength(1);
    // A settled window is not opened again by a later begin.
    expect((await begin(token)).body).toStrictEqual({ code: 'RESET_LINK_INVALID' });
    expect(await windowsOf(token)).toStrictEqual([{ settled: true, reset_settled: true }]);
  });
});
