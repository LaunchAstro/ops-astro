// SPDX-License-Identifier: AGPL-3.0-only
//
// The security review of C39-T P1 (SEC27), its two findings left to P3's
// accept on the one-time link.
//
// F5: a resend or a revoke ends every token minted before it. A link an
// email already carried is refused at accept once either is applied, before
// any new send, and writes nothing; the accept's spend holds the invitation
// pending, the token unspent, its business and the address the login was
// made for, all under the invitation's lock.
//
// F6: a token's hash is unique in its business only, and the accept arrives
// with no business. The lookup by hash is one narrow security definer
// function, answering the business, the invitation and the token ids and
// nothing more; PUBLIC may not run it, the application group alone may. A
// hash two businesses hold accepts in neither.

import { createHash } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { acceptInvitation } from '../../packages/core-commands/src/index.ts';
import {
  e,
  enrolVia,
  invited,
  passwordFor,
  rowsIn,
  spentOf,
  tokenTo,
  useEnrolWorld,
} from './c39-t-enrol-world.ts';
import { addressFor, as, c, codeOf, noDatabase, send, w } from './c39-t-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEnrolWorld();

const REFUSED = { status: 404, body: { code: 'ENROLMENT_LINK_INVALID' }, cookie: null };

/** The identity rows a business holds, to show a refusal wrote none. */
async function identityRows(business: string): Promise<readonly number[]> {
  const tables = ['logins', 'person_logins', 'memberships', 'actors', 'person_identifiers'];
  return await Promise.all(tables.map(async (table) => await rowsIn(table, business)));
}

async function resend(invitationId: string): Promise<void> {
  expect(codeOf(await as(c.admin, 'invitation.resend', { invitationId }))).toBe('applied');
}

it('SEC27 F5: a resend ends the link minted before it, before its own send: that link is refused at accept, asking and writing nothing', async () => {
  e.users.mode('accept');
  const address = addressFor('resent-unsent');
  const older = await invited(c.admin, address);
  await resend(older.id);
  const asked = e.users.received.length;
  const rows = await identityRows(w.alpha);

  expect(await enrolVia(older.token)).toStrictEqual(REFUSED);
  expect(e.users.received).toHaveLength(asked);
  expect(await identityRows(w.alpha)).toStrictEqual(rows);
  expect((await spentOf(older.id)).state).toBe('pending');

  // The control: the resend's own link, once sent, enrols.
  expect(await send(older.id)).toMatchObject({ ok: true });
  expect((await enrolVia(tokenTo(address))).body).toStrictEqual({ state: 'enrolled' });
});

it('SEC27 F5: a resend or a revoke leaves no token minted before it unspent', async () => {
  const resent = await invited(c.admin, addressFor('resent-at-rest'));
  await resend(resent.id);
  expect(await spentOf(resent.id)).toStrictEqual({ state: 'pending', spent: 1, tokens: 1 });

  const revoked = await invited(c.admin, addressFor('revoked-at-rest'));
  expect(codeOf(await as(c.admin, 'invitation.revoke', { invitationId: revoked.id }))).toBe(
    'applied',
  );
  expect(await spentOf(revoked.id)).toStrictEqual({ state: 'revoked', spent: 1, tokens: 1 });
});

it('SEC27 F5: a resend applied while the login is being made stops the bind, and the resend’s own link then enrols', async () => {
  e.users.mode('accept');
  const address = addressFor('resent-mid-accept');
  const first = await invited(c.admin, address);
  const rows = await identityRows(w.alpha);
  e.users.beforeNext(async () => {
    await resend(first.id);
  });

  expect(await enrolVia(first.token)).toStrictEqual(REFUSED);
  expect(await identityRows(w.alpha)).toStrictEqual(rows);
  expect((await spentOf(first.id)).state).toBe('pending');

  expect(await send(first.id)).toMatchObject({ ok: true });
  expect((await enrolVia(tokenTo(address))).body).toStrictEqual({ state: 'enrolled' });
});

it('SEC27 F5: the bind holds the address the login was made for: an invitation whose address moved meanwhile seats no one', async () => {
  e.users.mode('accept');
  const first = await invited(c.admin, addressFor('moved-mid-accept'));
  const rows = await identityRows(w.alpha);
  e.users.beforeNext(async () => {
    await w.db.admin.execute('update public.invitations set address = $1 where id = $2', [
      addressFor('moved-to'),
      first.id,
    ]);
  });

  expect(await enrolVia(first.token)).toStrictEqual(REFUSED);
  expect(await identityRows(w.alpha)).toStrictEqual(rows);
  expect(await spentOf(first.id)).toStrictEqual({ state: 'pending', spent: 0, tokens: 1 });
});

it('SEC27 F6: one narrow security definer function looks a token up by its hash, answering three ids; PUBLIC may not run it, the application group alone may', async () => {
  const [fn] = await w.db.admin.execute<{
    definer: boolean;
    config: readonly string[] | null;
    result: string;
    runners: readonly string[];
  }>(
    `select p.prosecdef as definer, p.proconfig as config,
            pg_get_function_result(p.oid) as result,
            array(select coalesce(nullif(a.grantee, 0)::regrole::text, 'PUBLIC')
                    from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner
                   order by 1) as runners
       from pg_proc p
      where p.oid = to_regprocedure('public.enrolment_token_find(text)')`,
  );
  expect(fn).toStrictEqual({
    definer: true,
    config: ['search_path=pg_catalog', 'row_security=off'],
    result: 'TABLE(business_id uuid, invitation_id uuid, token_id uuid)',
    runners: ['ops_astro_app'],
  });
});

it('SEC27 F6: the accept finds its token through that one lookup, once, never by a read in each business', async () => {
  const from = w.db.app.log.entries.length;
  const answer = await acceptInvitation(w.db.app, [w.alpha, w.bravo], w.broker, {
    token: Buffer.alloc(32, 9).toString('base64url'),
    password: passwordFor(),
  });
  expect(answer).toStrictEqual({ ok: false, code: 'ENROLMENT_LINK_INVALID' });
  const sent = w.db.app.log.entries.slice(from).map((statement) => statement.text);
  expect(sent.filter((text) => text.includes('enrolment_token_find('))).toHaveLength(1);
  expect(sent.filter((text) => /from\s+(public\.)?enrolment_tokens\b/u.test(text))).toEqual([]);
});

it('SEC27 F6: a hash two businesses hold accepts in neither, and nothing is asked or spent', async () => {
  e.users.mode('accept');
  const alpha = await invited(c.admin, addressFor('hash-in-alpha'));
  const bravo = await invited(c.bravoAdmin, addressFor('hash-in-bravo'), w.bravo);
  const hash = createHash('sha256').update(alpha.token).digest('hex');
  await w.db.admin.execute(
    'update public.enrolment_tokens set token_hash = $1 where invitation_id = $2',
    [hash, bravo.id],
  );
  const asked = e.users.received.length;

  expect(await enrolVia(alpha.token)).toStrictEqual(REFUSED);
  expect(e.users.received).toHaveLength(asked);
  for (const id of [alpha.id, bravo.id]) {
    // oxlint-disable-next-line no-await-in-loop
    expect(await spentOf(id)).toStrictEqual({ state: 'pending', spent: 0, tokens: 1 });
  }
});
