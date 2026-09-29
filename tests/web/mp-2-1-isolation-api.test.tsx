// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-1 isolation, business to business, against the real boundary and a
// fresh Postgres. The held-address switch names a business only where the
// person holds a grant there, and the only thing that decides that is the
// server: the application's probe is `session.capabilities` under the held
// business's prefix, sent with the new bearer through the mounted API.
//
// Two businesses, Alpha and Bravo, and four made-up people: one with a grant in
// both, one in Alpha only, one in Bravo only, and one who is a member of Bravo
// with no grant there. Only the first is offered a switch, in either direction.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { heldAddressOffer } from '../../apps/web/src/held-address.tsx';
import { createApiFixture, tokenFor, type ApiFixture } from '../api/fixture.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

/** A login for `subject` in `businessId`, mapped to a new person there, with or without a grant. */
async function enrolAs(
  database: Database,
  businessId: string,
  subject: string,
  grant: boolean,
): Promise<void> {
  await database.withBusiness(businessId, async (tx) => {
    const personId = await insertPerson(tx, subject);
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    const loginId = await insertLogin(tx, subject);
    await insertMapping(tx, loginId, personId, actorId);
    const member: Member = { personId, actorId, presented: { provider: 'supabase', subject } };
    if (grant) await grantTo(tx, member, 'read');
  });
}

describe.skipIf(serverUrl === undefined)('MP-2-1 isolation', () => {
  let fixture: ApiFixture;
  let api: Hono;
  const subjects = {
    both: `both-${randomUUID()}`,
    alphaOnly: `alpha-only-${randomUUID()}`,
    bravoOnly: `bravo-only-${randomUUID()}`,
    bravoNoGrant: `bravo-no-grant-${randomUUID()}`,
  };

  beforeAll(async () => {
    fixture = await createApiFixture('mp_2_1_isolation');
    api = fixture.compose();
    const bravo = await insertBusiness(fixture.db.app, 'bravo');
    await enrolAs(fixture.db.app, fixture.business, subjects.both, true);
    await enrolAs(fixture.db.app, bravo, subjects.both, true);
    await enrolAs(fixture.db.app, fixture.business, subjects.alphaOnly, true);
    await enrolAs(fixture.db.app, bravo, subjects.bravoOnly, true);
    await enrolAs(fixture.db.app, fixture.business, subjects.bravoNoGrant, true);
    await enrolAs(fixture.db.app, bravo, subjects.bravoNoGrant, false);
  }, 120_000);

  afterAll(async () => await fixture?.drop());

  const through = ((url: string | URL, init?: RequestInit) =>
    api.fetch(new Request(`http://api.test${String(url)}`, init))) as typeof fetch;

  async function offer(subject: string, heldIn: string, signedInTo: string) {
    return await heldAddressOffer({
      held: { address: '/task/TSK-1', businessKey: heldIn, code: 'AUTH_SESSION_EXPIRED' },
      next: { token: await tokenFor(subject), businessKey: signedInTo, email: 'x@example.test' },
      apiOrigin: '',
      fetch: through,
    });
  }

  it('offers the switch to a person holding a grant in the held business, both ways', async () => {
    expect(await offer(subjects.both, 'bravo', 'alpha')).toEqual({
      kind: 'switch',
      businessKey: 'bravo',
      address: '/task/TSK-1',
    });
    expect(await offer(subjects.both, 'alpha', 'bravo')).toEqual({
      kind: 'switch',
      businessKey: 'alpha',
      address: '/task/TSK-1',
    });
  });

  it('names no business to a person with no login there', async () => {
    expect(await offer(subjects.alphaOnly, 'bravo', 'alpha')).toEqual({ kind: 'unnamed' });
    expect(await offer(subjects.bravoOnly, 'alpha', 'bravo')).toEqual({ kind: 'unnamed' });
  });

  it('names no business to a member who holds no grant there', async () => {
    expect(await offer(subjects.bravoNoGrant, 'bravo', 'alpha')).toEqual({ kind: 'unnamed' });
  });

  it('names no business for one that does not exist, the same as one the person is not in', async () => {
    expect(await offer(subjects.both, 'charlie', 'alpha')).toEqual({ kind: 'unnamed' });
  });
});
