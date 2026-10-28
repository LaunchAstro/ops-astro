// SPDX-License-Identifier: AGPL-3.0-only
//
// #2308: business bravo has an administrator in the local seed, holding the
// admin role's grants, so a live trial can cross from alpha to bravo with a
// bravo holder who has the keys, rather than one refused at the grant layer.

import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GRANTS_BY_ROLE } from '../../scripts/local-seed-roles.ts';
import {
  businessOf,
  closeWorld,
  openCast,
  serverUrl,
  type Cast,
} from './click-through-seed.fixture.ts';

interface Login {
  readonly email: string;
  readonly businessKey: string;
  readonly role: string;
}

// auth:seed's own list, by path: it is a plain script with no types.
const logins: string = resolve(import.meta.dirname, '../../scripts/local/synthetic-logins.mjs');

it("auth:seed's list has an administrator of bravo", async () => {
  const { PEOPLE } = (await import(logins)) as { PEOPLE: readonly Login[] };
  const admins = PEOPLE.filter((login) => login.businessKey === 'bravo' && login.role === 'admin');
  expect(admins).toHaveLength(1);
});

let cast: Cast;

describe.skipIf(serverUrl === undefined)("#2308 local-seed's bravo administrator", () => {
  beforeAll(async () => {
    cast = await openCast('ls2308bravoadmin');
  }, 300_000);

  afterAll(async () => {
    await closeWorld(cast);
  });

  it("seeds one active bravo administrator holding exactly the admin role's grants", async () => {
    const bravo = await businessOf(cast.db, 'bravo');
    const admins = await cast.db.admin.execute<{ person_id: string }>(
      `select person_id from public.memberships
        where business_id = $1 and role_key = 'admin' and active`,
      [bravo],
    );
    expect(admins).toHaveLength(1);
    const grants = await cast.db.admin.execute<{ pair: string }>(
      `select collection || ':' || action as pair from public.grants
        where business_id = $1 and subject_kind = 'person' and subject_id = $2
          and scope_kind = 'business' and revoked_at is null order by 1`,
      [bravo, admins[0]!.person_id],
    );
    expect(grants.map((row) => row.pair).toSorted()).toStrictEqual(
      GRANTS_BY_ROLE.admin.map(([collection, action]) => `${collection}:${action}`).toSorted(),
    );
  });
});
