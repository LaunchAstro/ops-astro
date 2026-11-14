// SPDX-License-Identifier: AGPL-3.0-only
//
// #2454 through the API's own composition root: one provider login mapped into two businesses
// is judged in each by that business's own rows. Noah signs in once; a bearer for his subject
// saves a preference in alpha and in bravo, each path naming its business by key. Once alpha's
// owner ends his alpha access, a fresh bearer is refused in alpha and still served in bravo.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { PREFIX } from '../../packages/core-wire/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type ApiFixture,
} from './fixture.ts';

const BRAVO = 'bravo';

let fixture: ApiFixture | undefined;
let api: Hono;
let ada: Member;
let noah: Member;

/** `member`'s subject mapped into `businessId` as a member there, with its own person and actor. */
async function alsoMemberOf(world: ApiFixture, businessId: string, member: Member): Promise<void> {
  await world.db.app.withBusiness(businessId, async (tx) => {
    const personId = await insertPerson(tx, 'Noah Bravo');
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    const loginId = await insertLogin(tx, member.presented.subject);
    await insertMapping(tx, loginId, personId, actorId);
  });
}

beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  const world = await createApiFixture('one_login_two_businesses_api');
  fixture = world;
  const bravo = await insertBusiness(world.db.app, BRAVO);
  await installSpine(world.db.app, bravo);
  ada = await enrol(world.db.app, world.business, 'Ada Lane');
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, ada, 'manage', WHOLE_BUSINESS, false, 'access');
  });
  noah = await enrol(world.db.app, world.business, 'Noah Alpha');
  await alsoMemberOf(world, bravo, noah);
  api = world.compose();
}, 120_000);

afterAll(async () => {
  await fixture?.drop();
});

/** The answer's refusal code, or `applied`. */
const codeOf = (answer: { readonly status: number; readonly body: Record<string, unknown> }) =>
  answer.body['refused'] === true ? String(answer.body['code']) : `applied ${answer.status}`;

async function save(key: string, value: string): Promise<string> {
  const token = await tokenFor(noah.presented.subject, { secondFactor: true });
  return codeOf(
    await post(
      api,
      `${PREFIX.person}${key}/preference/save`,
      { operationId: randomUUID(), preference: 'appearance', value },
      authorised(token),
    ),
  );
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  '#2454 one login in two businesses, through the API',
  () => {
    it('is served in each business it is a member of', async () => {
      expect([await save(BUSINESS_KEY, 'dark'), await save(BRAVO, 'dark')]).toStrictEqual([
        'applied 200',
        'applied 200',
      ]);
    });

    it('once its alpha access is ended, is refused in alpha and still served in bravo', async () => {
      const token = await tokenFor(ada.presented.subject, { secondFactor: true });
      const ended = await post(
        api,
        `${PREFIX.person}${BUSINESS_KEY}/access/end`,
        { operationId: randomUUID(), holderId: noah.personId },
        authorised(token),
      );
      expect(codeOf(ended)).toBe('applied 200');
      expect([await save(BUSINESS_KEY, 'light'), await save(BRAVO, 'light')]).toStrictEqual([
        'AUTH_ACCESS_ENDED',
        'applied 200',
      ]);
    });
  },
);
