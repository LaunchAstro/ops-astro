// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P3: the login an accept asks the provider for is ours, under
// an id that is the same every time for one address in one business, so a
// login the provider made behind an answer that never arrived, or before its
// link died, is found again and adopted by the next accept with the password
// set then. A login that is not ours, another business's or one made
// elsewhere, is never set: its holder is told to sign in. A login this
// business has bound already is never set again, and nothing is asked. A
// hostile answer spends and binds nothing, and the same link then enrols.

import { describe, expect, it } from 'vitest';
import type { FakeUsersMode } from './c39-t-users-fake.ts';
import {
  e,
  enrolVia,
  invited,
  passwordFor,
  rowsIn,
  spentOf,
  useEnrolWorld,
} from './c39-t-enrol-world.ts';
import { addressFor, as, c, codeOf, noDatabase, storedText, w } from './c39-t-world.ts';

useEnrolWorld();

const SIGN_IN = { status: 200, body: { state: 'sign_in' }, cookie: null };
const ENROLLED = { status: 200, body: { state: 'enrolled' }, cookie: null };

/** The PUTs the provider was asked for since `from`. */
const putsSince = (from: number): readonly string[] =>
  e.users.received
    .slice(from)
    .filter((one) => one.method === 'PUT')
    .map((one) => one.path);

/** The person a provider subject is bound to in one business, if any. */
async function boundTo(business: string, subject: string): Promise<string | undefined> {
  const [row] = await w.db.admin.execute<{ person_id: string }>(
    `select pl.person_id from public.person_logins pl
       join public.logins l on l.id = pl.login_id
      where l.business_id = $1 and l.subject = $2`,
    [business, subject],
  );
  return row?.person_id;
}

/** The invitation's person, as the database holds it. */
async function personOf(invitationId: string): Promise<string> {
  const [row] = await w.db.admin.execute<{ person_id: string }>(
    'select person_id from public.invitations where id = $1',
    [invitationId],
  );
  return String(row?.person_id);
}

/** The identity rows alpha holds, to show a refusal wrote none. */
async function identityRows(): Promise<readonly number[]> {
  const tables = ['logins', 'person_logins', 'memberships', 'actors', 'person_identifiers'];
  return await Promise.all(tables.map(async (table) => await rowsIn(table, w.alpha)));
}

/** Accept once while the provider makes the user and answers too late. */
async function strand(token: string, password: string = passwordFor()): Promise<void> {
  e.users.mode('made_late');
  expect((await enrolVia(token, password)).status).toBe(503);
  e.users.mode('accept');
}

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(noDatabase)('C39-T enrolment recovery', () => {
  it('C39-T enrolment: the password set at the adopting accept is the one the provider is sent, and it reaches no log, answer or stored row', async () => {
    const address = addressFor('adopted');
    const { id, token } = await invited(c.admin, address);
    const first = passwordFor();
    await strand(token, first);
    const made = String(e.users.users.get(address));
    expect(e.users.passwords.get(made)).toBe(first);

    const now = passwordFor();
    const from = e.users.received.length;
    const answer = await enrolVia(token, now);
    expect(answer).toStrictEqual(ENROLLED);
    expect(putsSince(from)).toStrictEqual([`/auth/v1/admin/users/${made}`]);
    expect(e.users.received.at(-1)?.body).toMatchObject({ email: address, password: now });
    expect(e.users.passwords.get(made)).toBe(now);
    expect(await boundTo(w.alpha, made)).toBe(await personOf(id));
    const stored = await storedText();
    for (const password of [first, now]) {
      expect(JSON.stringify(answer)).not.toContain(password);
      expect(stored.includes(password)).toBe(false);
      expect(w.custody.stderr()).not.toContain(password);
    }
  }, 30_000);

  it('C39-T enrolment: a password the provider refuses is PASSWORD_INVALID, never sign_in, and nothing is made, set or spent', async () => {
    e.users.mode('weak_password');
    const address = addressFor('weak-password');
    const { id, token } = await invited(c.admin, address);
    const asked = e.users.received.length;
    expect(await enrolVia(token)).toStrictEqual({
      status: 400,
      body: { code: 'PASSWORD_INVALID' },
      cookie: null,
    });
    // The create alone was asked: a refused password is no reason to adopt a login.
    expect(e.users.received.slice(asked).map((one) => one.method)).toStrictEqual(['POST']);
    expect(e.users.users.has(address)).toBe(false);
    expect(await spentOf(id)).toStrictEqual({ state: 'pending', spent: 0, tokens: 1 });
    e.users.mode('accept');
    expect((await enrolVia(token)).body).toStrictEqual({ state: 'enrolled' });
  });

  it('C39-T no account oracle: an address whose login is someone else’s answers sign_in, and no password is changed', async () => {
    // One login made in bravo, one made at the provider outside the product.
    const inBravo = addressFor('bravo-login');
    const bravo = await invited(c.bravoAdmin, inBravo, w.bravo);
    expect(await enrolVia(bravo.token)).toStrictEqual(ENROLLED);
    const outside = addressFor('outside-login');
    await fetch(`${e.users.origin}/auth/v1/admin/users`, {
      method: 'POST',
      body: JSON.stringify({ email: outside, password: passwordFor() }),
    });
    for (const address of [inBravo, outside]) {
      const theirs = String(e.users.users.get(address));
      const password = e.users.passwords.get(theirs);
      // oxlint-disable-next-line no-await-in-loop
      const alpha = await invited(c.admin, address);
      const from = e.users.received.length;
      // oxlint-disable-next-line no-await-in-loop
      expect(await enrolVia(alpha.token), address).toStrictEqual(SIGN_IN);
      // The one PUT names our id, which the provider does not hold, never theirs.
      expect(putsSince(from)).toHaveLength(1);
      expect(putsSince(from)[0]).not.toContain(theirs);
      expect(e.users.passwords.get(theirs)).toBe(password);
      expect(e.users.users.get(address)).toBe(theirs);
      // oxlint-disable-next-line no-await-in-loop
      expect(await spentOf(alpha.id)).toStrictEqual({ state: 'pending', spent: 0, tokens: 1 });
    }
  });

  it('C39-T enrolment: an address this business has bound a login for answers sign_in and asks the provider nothing', async () => {
    const address = addressFor('bound-here');
    const before = await invited(c.admin, address);
    expect(await enrolVia(before.token)).toStrictEqual(ENROLLED);
    const subject = String(e.users.users.get(address));
    const password = e.users.passwords.get(subject);
    // The member leaves, keeping the login, and is invited again.
    await w.db.admin.execute(
      'update public.memberships set active = false, ended_at = now() where person_id = $1',
      [await personOf(before.id)],
    );
    const again = await invited(c.admin, address);
    const logins = await rowsIn('logins', w.alpha);
    const from = e.users.received.length;
    expect(await enrolVia(again.token)).toStrictEqual(SIGN_IN);
    expect(e.users.received).toHaveLength(from);
    expect(e.users.passwords.get(subject)).toBe(password);
    expect(await rowsIn('logins', w.alpha)).toBe(logins);
    expect(await spentOf(again.id)).toStrictEqual({ state: 'pending', spent: 0, tokens: 1 });
  });

  it('C39-T enrolment: a link revoked between the find and the bind enrols no one, and a fresh invitation for the address enrols with the login made then', async () => {
    const address = addressFor('revoked-mid-accept');
    const first = await invited(c.admin, address);
    e.users.beforeNext(async () => {
      expect(codeOf(await as(c.admin, 'invitation.revoke', { invitationId: first.id }))).toBe(
        'applied',
      );
    });
    expect(await enrolVia(first.token)).toStrictEqual({
      status: 404,
      body: { code: 'ENROLMENT_LINK_INVALID' },
      cookie: null,
    });
    const made = String(e.users.users.get(address));
    expect(await boundTo(w.alpha, made)).toBeUndefined();

    const fresh = await invited(c.admin, address);
    expect(await enrolVia(fresh.token)).toStrictEqual(ENROLLED);
    expect(e.users.users.get(address)).toBe(made);
    expect(await boundTo(w.alpha, made)).toBe(await personOf(fresh.id));
    expect(await spentOf(fresh.id)).toStrictEqual({ state: 'accepted', spent: 1, tokens: 1 });
  });

  // eslint-disable-next-line max-lines-per-function -- the business crossing and the person crossing
  it('C39-T isolation: an invitation never adopts a login made for another business’s invitation or another address', async () => {
    // Business: bravo's accept strands a login for the address; alpha's never takes it.
    const address = addressFor('stranded-in-bravo');
    const bravo = await invited(c.bravoAdmin, address, w.bravo);
    const bravoPassword = passwordFor();
    await strand(bravo.token, bravoPassword);
    const bravoLogin = String(e.users.users.get(address));
    const alpha = await invited(c.admin, address);
    const logins = await rowsIn('logins', w.alpha);
    expect(await enrolVia(alpha.token)).toStrictEqual(SIGN_IN);
    expect(e.users.users.get(address)).toBe(bravoLogin);
    expect(e.users.passwords.get(bravoLogin)).toBe(bravoPassword);
    expect(await rowsIn('logins', w.alpha)).toBe(logins);
    // Bravo's own link adopts it, bound in bravo alone.
    expect(await enrolVia(bravo.token)).toStrictEqual(ENROLLED);
    expect(await boundTo(w.bravo, bravoLogin)).toBe(await personOf(bravo.id));
    expect(await boundTo(w.alpha, bravoLogin)).toBeUndefined();

    // Person: a login stranded for one address is not the next address's.
    const one = await invited(c.admin, addressFor('stranded-person'));
    const onePassword = passwordFor();
    await strand(one.token, onePassword);
    const oneLogin = [...e.users.passwords].find(([, set]) => set === onePassword)?.[0];
    const other = await invited(c.admin, addressFor('other-person'));
    expect(await enrolVia(other.token)).toStrictEqual(ENROLLED);
    expect(await boundTo(w.alpha, String(oneLogin))).toBeUndefined();
    expect(e.users.passwords.get(String(oneLogin))).toBe(onePassword);
  }, 30_000);

  // eslint-disable-next-line max-lines-per-function -- every hostile answer, then the control
  it('C39-T hostile provider: an answer echoing the password, oversized, redirected, malformed, naming another user, faulted or slow spends and binds nothing, and the same link then enrols', async () => {
    const address = addressFor('hostile');
    const { id, token } = await invited(c.admin, address);
    const rows = await identityRows();
    const modes: readonly FakeUsersMode[] = [
      'echo',
      'oversized',
      'redirect',
      'not_json',
      'bad_id',
      'other_id',
      'fault',
      'slow',
    ];
    const passwords: string[] = [];
    for (const mode of modes) {
      e.users.mode(mode);
      const password = passwordFor();
      passwords.push(password);
      // oxlint-disable-next-line no-await-in-loop
      expect(await enrolVia(token, password), mode).toStrictEqual({
        status: 503,
        body: { code: 'ENROLMENT_UNAVAILABLE' },
        cookie: null,
      });
      // oxlint-disable-next-line no-await-in-loop
      expect(await spentOf(id), mode).toStrictEqual({ state: 'pending', spent: 0, tokens: 1 });
    }
    expect(await identityRows()).toStrictEqual(rows);
    const stored = await storedText();
    for (const password of passwords) expect(stored.includes(password)).toBe(false);
    for (const password of passwords) expect(w.custody.stderr()).not.toContain(password);
    // The provider made one user, under our id, and nothing here bound it.
    const made = String(e.users.users.get(address));
    expect(await boundTo(w.alpha, made)).toBeUndefined();
    // The control: an honest answer, and the same link enrols with that user.
    e.users.mode('accept');
    expect((await enrolVia(token)).body).toStrictEqual({ state: 'enrolled' });
    expect(e.users.users.get(address)).toBe(made);
    expect(await boundTo(w.alpha, made)).toBe(await personOf(id));
    expect(await spentOf(id)).toStrictEqual({ state: 'accepted', spent: 1, tokens: 1 });
  }, 30_000);
});
