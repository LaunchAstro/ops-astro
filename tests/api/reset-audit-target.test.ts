// SPDX-License-Identifier: AGPL-3.0-only
//
// Every password `changed` writes at the provider is audited once, as the
// person the login mapped when the write was made, against the pinned GoTrue
// (`reset-world.ts`). A login mapped nowhere by then gets no write at all; a
// mapping that ends while the write is out still has its reset audited.

import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { mountPasswordReset } from '../../apps/api/password-reset.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import { authorised, post } from './fixture.ts';
import {
  alpha,
  auditsOf,
  begin,
  changed,
  db,
  issuer,
  linkMinted,
  linkSession,
  personIn,
  providerReady,
  signIn,
  useResetWorld,
  windowsOf,
  type Person,
} from './reset-world.ts';

const withProvider = it.skipIf(!providerReady);

useResetWorld('rstat');

const NEW_PASSWORD = 'a-new-password-for-reset';

/** The login's live mapping in `business` ended, as a removal from the business ends it. */
async function mappingEnded(person: Person, business: BusinessId): Promise<void> {
  await db.admin.execute(
    `update public.person_logins set active = false, deactivated_at = now()
      where business_id = $1 and person_id = $2 and active`,
    [business, person.people.get(business) ?? ''],
  );
}

/** What happens while the provider write is out, until a case says otherwise. */
const nothingDuringWrite = async (): Promise<void> => {};

withProvider('writes nothing for a login mapped nowhere by the time of changed', async () => {
  const person = await personIn(alpha);
  await linkMinted(person);
  const token = await linkSession(person);
  expect((await begin(token)).status).toBe(200);
  await mappingEnded(person, alpha);

  const answer = await changed(token, NEW_PASSWORD);
  expect(answer).toMatchObject({ status: 401, body: { code: 'RESET_LINK_INVALID' } });
  // The provider still holds the old password, and nothing settled or audited.
  expect(await signIn(person)).toEqual(expect.any(String));
  expect(await windowsOf(token)).toStrictEqual([{ settled: false, reset_settled: false }]);
  expect(await auditsOf(person, alpha)).toStrictEqual([]);
});

withProvider('audits the reset when the mapping ends while the write is out', async () => {
  const person = await personIn(alpha);
  await linkMinted(person);
  const token = await linkSession(person);
  let duringWrite = nothingDuringWrite;
  const server = new Hono();
  mountPasswordReset(server, db.app, {
    signIn: { issuer: issuer ?? '', keySetUrl: `${issuer ?? ''}/.well-known/jwks.json` },
    fetch: async (input, init) => {
      if (init?.method === 'PUT') await duringWrite();
      return await fetch(input, init);
    },
  });
  expect((await post(server, '/api/password/begin', {}, authorised(token))).status).toBe(200);
  duringWrite = async () => {
    await mappingEnded(person, alpha);
  };

  const answer = await post(
    server,
    '/api/password/changed',
    { password: NEW_PASSWORD },
    authorised(token),
  );
  expect(answer.status).toBe(200);
  expect(await signIn(person, NEW_PASSWORD)).toEqual(expect.any(String));
  expect(await windowsOf(token)).toStrictEqual([{ settled: true, reset_settled: true }]);
  const audits = await auditsOf(person, alpha);
  expect(audits).toHaveLength(1);
  expect(audits.join('')).not.toContain(NEW_PASSWORD);
});
