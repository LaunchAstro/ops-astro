// SPDX-License-Identifier: AGPL-3.0-only
//
// #2454: one provider login mapped into two businesses is judged in each by that business's own
// rows. Noah is a member of alpha and of bravo under one subject. His own write (`preference.save`)
// is served in both; once alpha's owner ends his alpha access, alpha refuses him and bravo still
// serves him. Every step goes through the command entry, as the API sends it, each call naming the
// business it means.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { enrol, grantTo, installSpine, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('#2454 one login in two businesses: DATABASE_URL is unset.');

let db: FreshDatabase;
let alpha: string;
let bravo: string;
let ada: Member;
let noah: Member;

/** `member`'s subject mapped into `businessId` as a member there, with its own person and actor. */
async function alsoMemberOf(businessId: string, member: Member, name: string): Promise<void> {
  await db.app.withBusiness(businessId, async (tx) => {
    const personId = await insertPerson(tx, name);
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    const loginId = await insertLogin(tx, member.presented.subject);
    await insertMapping(tx, loginId, personId, actorId);
  });
}

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'one_login_two_businesses' });
  alpha = await insertBusiness(db.app, 'alpha');
  bravo = await insertBusiness(db.app, 'bravo');
  await installSpine(db.app, alpha);
  await installSpine(db.app, bravo);
  ada = await enrol(db.app, alpha, 'Ada Lane');
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, ada, 'manage', WHOLE_BUSINESS, false, 'access');
  });
  noah = await enrol(db.app, alpha, 'Noah Alpha');
  await alsoMemberOf(bravo, noah, 'Noah Bravo');
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const codeOf = (answer: CommandResult): string =>
  isCommandRefusal(answer) ? answer.code : 'applied';

const save = async (businessId: string, value: string): Promise<string> =>
  codeOf(
    await executeCommand(db.app, businessId, noah.presented, 'api', {
      command: 'preference.save',
      operationId: randomUUID(),
      preference: 'appearance',
      value,
    } as never),
  );

describe.skipIf(serverUrl === undefined)('#2454 one login in two businesses', () => {
  it('is served in each business it is a member of', async () => {
    expect([await save(alpha, 'dark'), await save(bravo, 'dark')]).toStrictEqual([
      'applied',
      'applied',
    ]);
  });

  it('once its alpha access is ended, is refused in alpha and still served in bravo', async () => {
    const ended = await executeCommand(db.app, alpha, ada.presented, 'api', {
      command: 'access.end',
      operationId: randomUUID(),
      holderId: noah.personId,
    } as never);
    expect(codeOf(ended)).toBe('applied');
    expect([await save(alpha, 'light'), await save(bravo, 'light')]).toStrictEqual([
      'AUTH_ACCESS_ENDED',
      'applied',
    ]);
  });
});
