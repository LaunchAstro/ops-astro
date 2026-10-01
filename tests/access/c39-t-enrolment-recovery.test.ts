// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P3: the login an accept asks the provider for is ours, under
// an id that is the same every time for one address in one business, and no
// accept sends the provider a PUT. A login made behind an answer that never
// arrived, or before its link died, keeps its holder's password: the same
// link answers sign_in, and signed in with it, the holder enrols. A login
// another business made, or one made elsewhere, is never set either. A login
// this business has bound already answers sign_in, and nothing is asked. Of
// two accepts for one address, racing on one link or on a revoked link and a
// fresh one, neither sets the password of the login the other bound. A
// hostile answer spends and binds nothing, and the same link then enrols.

import { describe, expect, it } from 'vitest';
import type { FakeUsersMode } from './c39-t-users-fake.ts';
import {
  bindVia,
  boundTo,
  e,
  type Answer,
  enrolVia,
  invited,
  loginOf,
  passwordFor,
  patientApp,
  personOf,
  rowsIn,
  spentOf,
  useEnrolWorld,
} from './c39-t-enrol-world.ts';
import { addressFor, as, c, codeOf, noDatabase, storedText, w } from './c39-t-world.ts';

useEnrolWorld();

const SIGN_IN = { status: 200, body: { state: 'sign_in' }, cookie: null };
const ENROLLED = { status: 200, body: { state: 'enrolled' }, cookie: null };
const JOINED = { status: 200, body: { state: 'joined' }, cookie: null };

/** The PUTs the provider was asked for since `from`. */
const putsSince = (from: number): readonly string[] =>
  e.users.received
    .slice(from)
    .filter((one) => one.method === 'PUT')
    .map((one) => one.path);

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

type Link = Readonly<Record<'address' | 'id' | 'token', string> & { mode: FakeUsersMode }>;

/** An honest retry of a hostile answer's link: a login it made is never set, and enrols. */
async function recover({ mode, address, id, token }: Link): Promise<void> {
  const made = e.users.users.get(address);
  if (made === undefined) {
    expect(mode).toBe('fault');
    expect(await enrolVia(token), mode).toStrictEqual(ENROLLED);
  } else {
    const password = e.users.passwords.get(made);
    expect(await enrolVia(token), mode).toStrictEqual(SIGN_IN);
    expect(await bindVia(token, loginOf(made)), mode).toStrictEqual(JOINED);
    expect(e.users.passwords.get(made), mode).toBe(password);
    expect(await boundTo(w.alpha, made), mode).toBe(await personOf(id));
  }
  expect(await spentOf(id), mode).toStrictEqual({ state: 'accepted', spent: 1, tokens: 1 });
}

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(noDatabase)('C39-T enrolment recovery', () => {
  it('C39-T enrolment: a stranded login keeps the password its holder set, the same link answers sign_in and sets nothing, and signed in the link enrols; no password reaches a log, answer or stored row', async () => {
    const address = addressFor('stranded');
    const { id, token } = await invited(c.admin, address);
    const first = passwordFor();
    await strand(token, first);
    const made = String(e.users.users.get(address));
    expect(e.users.passwords.get(made)).toBe(first);

    const now = passwordFor();
    const from = e.users.received.length;
    const answer = await enrolVia(token, now);
    expect(answer).toStrictEqual(SIGN_IN);
    expect(putsSince(from)).toStrictEqual([]);
    expect(await spentOf(id)).toStrictEqual({ state: 'pending', spent: 0, tokens: 1 });
    expect(await bindVia(token, loginOf(made))).toStrictEqual(JOINED);
    expect(e.users.passwords.get(made)).toBe(first);
    expect(await boundTo(w.alpha, made)).toBe(await personOf(id));
    const stored = await storedText();
    for (const password of [first, now]) {
      expect(JSON.stringify(answer)).not.toContain(password);
      expect(stored.includes(password)).toBe(false);
      expect(w.custody.stderr()).not.toContain(password);
    }
  }, 30_000);

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
      // Nothing is set: no PUT, under our id or theirs.
      expect(putsSince(from)).toStrictEqual([]);
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

  it('C39-T enrolment: a link revoked between the find and the bind enrols no one, and a fresh invitation for the address answers sign_in, then enrols signed in with the login made then', async () => {
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

    const password = e.users.passwords.get(made);
    const fresh = await invited(c.admin, address);
    expect(await enrolVia(fresh.token)).toStrictEqual(SIGN_IN);
    expect(await bindVia(fresh.token, loginOf(made))).toStrictEqual(JOINED);
    expect(e.users.passwords.get(made)).toBe(password);
    expect(e.users.users.get(address)).toBe(made);
    expect(await boundTo(w.alpha, made)).toBe(await personOf(fresh.id));
    expect(await spentOf(fresh.id)).toStrictEqual({ state: 'accepted', spent: 1, tokens: 1 });
  });

  // eslint-disable-next-line max-lines-per-function -- the business crossing and the person crossing
  it('C39-T isolation: an invitation never sets or binds a login made for another business’s invitation or another address', async () => {
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
    // Bravo's own link sets it neither; signed in with it, bravo's link binds it in bravo alone.
    expect(await enrolVia(bravo.token)).toStrictEqual(SIGN_IN);
    expect(e.users.passwords.get(bravoLogin)).toBe(bravoPassword);
    expect(await bindVia(bravo.token, loginOf(bravoLogin))).toStrictEqual(JOINED);
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

  it('C39-T enrolment: a second accept on the same link, racing the first, never sets the password of the login the first bound', async () => {
    const address = addressFor('raced');
    const { id, token } = await invited(c.admin, address);
    const winner = passwordFor();
    let first: Answer | undefined;
    // The second accept has found its link live; while its ask is at the provider, the first enrols whole.
    e.users.beforeNext(async () => {
      first = await enrolVia(token, winner);
    });
    // The second accept waits on the provider as long as a deployment does.
    const second = await enrolVia(token, passwordFor(), patientApp());
    expect(first).toStrictEqual(ENROLLED);
    const made = String(e.users.users.get(address));
    expect(await boundTo(w.alpha, made)).toBe(await personOf(id));
    expect(second).toStrictEqual(SIGN_IN);
    expect(e.users.passwords.get(made)).toBe(winner);
  }, 30_000);

  it('C39-T enrolment: a revoked link’s accept in flight never sets the password of the login a fresh invitation for the address bound', async () => {
    const address = addressFor('revoked-raced');
    const old = await invited(c.admin, address);
    const winner = passwordFor();
    let freshId = '';
    let first: Answer | undefined;
    // The old link's accept has found it live; while its ask is at the provider, the old
    // invitation is revoked, a fresh one sent, and the fresh link enrols whole.
    e.users.beforeNext(async () => {
      expect(codeOf(await as(c.admin, 'invitation.revoke', { invitationId: old.id }))).toBe(
        'applied',
      );
      const fresh = await invited(c.admin, address);
      freshId = fresh.id;
      first = await enrolVia(fresh.token, winner);
    });
    const late = await enrolVia(old.token, passwordFor(), patientApp());
    expect(first).toStrictEqual(ENROLLED);
    const made = String(e.users.users.get(address));
    expect(await boundTo(w.alpha, made)).toBe(await personOf(freshId));
    expect(late.body).not.toStrictEqual({ state: 'enrolled' });
    expect(e.users.passwords.get(made)).toBe(winner);
    expect(await spentOf(old.id)).toStrictEqual({ state: 'revoked', spent: 0, tokens: 1 });
  }, 30_000);

  // eslint-disable-next-line max-lines-per-function -- every hostile answer, then the control
  it('C39-T hostile provider: an answer echoing the password, oversized, redirected, malformed, naming another user, faulted or slow spends and binds nothing, and the same link then enrols, signed in with any login it made', async () => {
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
    // Each mode on a link of its own: a login one hostile answer made would answer the next create.
    const links: Link[] = [];
    const passwords: string[] = [];
    for (const mode of modes) {
      const address = addressFor(`hostile-${mode}`);
      // oxlint-disable-next-line no-await-in-loop
      const { id, token } = await invited(c.admin, address);
      links.push({ mode, address, id, token });
      e.users.mode(mode);
      const password = passwordFor();
      passwords.push(password);
      // oxlint-disable-next-line no-await-in-loop
      expect(await enrolVia(token, password), mode).toStrictEqual({
        status: 503,
        body: { code: 'ENROLMENT_UNAVAILABLE' },
        cookie: null,
      });
      e.users.mode('accept');
      // oxlint-disable-next-line no-await-in-loop
      expect(await spentOf(id), mode).toStrictEqual({ state: 'pending', spent: 0, tokens: 1 });
    }
    expect(await identityRows()).toStrictEqual(rows);
    const stored = await storedText();
    for (const password of passwords) expect(stored.includes(password)).toBe(false);
    for (const password of passwords) expect(w.custody.stderr()).not.toContain(password);
    // The control: an honest answer, and each link enrols.
    // oxlint-disable-next-line no-await-in-loop
    for (const link of links) await recover(link);
  }, 60_000);

  it('C39-T enrolment: across every recovery case the login provider is never sent a PUT', () => {
    expect(e.users.received.length).toBeGreaterThan(0);
    expect(putsSince(0)).toStrictEqual([]);
  });
});
