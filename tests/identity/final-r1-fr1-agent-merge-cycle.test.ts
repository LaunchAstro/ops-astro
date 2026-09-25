// SPDX-License-Identifier: AGPL-3.0-only
//
// A merge cycle degrades to "no merge" (review finding #57). The chain walk's
// CYCLE clause stops the recursion, and what it resolves to afterwards is the
// point of this file: a person inside a cycle is themselves, so an identifier
// on one member of the cycle attaches to that member and not to whoever the
// walk happened to be standing on when it noticed it had gone round.
//
// The symmetric case in `identifier-resolution.test.ts` puts the identifier on
// both members of a two-cycle, which reads the same whichever way each member
// resolves. These cases put it on one side only.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  resolveIdentifier,
  type IdentifierResolution,
} from '../../packages/core-records/src/identity/identifier-resolution.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  insertActor,
  insertBusiness,
  insertIdentifier,
  insertMerge,
  insertPerson,
} from './fixture.ts';

function candidatesOf(resolution: IdentifierResolution): readonly string[] {
  if (resolution.outcome !== 'unresolved') {
    throw new Error(`expected unresolved, and it attached to ${resolution.personId}`);
  }
  return [...resolution.candidatePersonIds].toSorted();
}

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'merge cycle: DATABASE_URL is unset, so the cycle cases did not run and nothing is proved.',
  );
}

describe.skipIf(serverUrl === undefined)('a merge cycle degrades to no merge', () => {
  let db: FreshDatabase;
  let business: string;

  const observe = async (value: string): Promise<IdentifierResolution> =>
    await db.app.withBusiness(business, (tx) =>
      resolveIdentifier(tx, { kind: 'email', value, sourceSystem: 'import' }),
    );

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'b' });
    business = await insertBusiness(db.app, 'cycle');
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('attaches an identifier on one side of a two-cycle to that side', async () => {
    const ash = await db.app.withBusiness(business, async (tx) => {
      const one = await insertPerson(tx, 'Ash');
      const two = await insertPerson(tx, 'Asa');
      const actor = await insertActor(tx, one);
      await insertIdentifier(tx, one, 'ash-only@example.com', 'crm');
      await insertMerge(tx, two, one, actor);
      await insertMerge(tx, one, two, actor);
      return one;
    });
    expect(await observe('ash-only@example.com')).toMatchObject({
      outcome: 'attached',
      personId: ash,
      person: 'existing',
    });
  }, 20_000);

  it('names the two people the identifier is on in a three-cycle', async () => {
    // A absorbed into B, B into C, C into A.
    const [a, b] = await db.app.withBusiness(business, async (tx) => {
      const one = await insertPerson(tx, 'Cyd');
      const two = await insertPerson(tx, 'Cye');
      const three = await insertPerson(tx, 'Cyl');
      const actor = await insertActor(tx, one);
      await insertIdentifier(tx, one, 'three@example.com', 'crm');
      await insertIdentifier(tx, two, 'three@example.com', 'forms');
      await insertMerge(tx, two, one, actor);
      await insertMerge(tx, three, two, actor);
      await insertMerge(tx, one, three, actor);
      return [one, two] as const;
    });
    expect(candidatesOf(await observe('three@example.com'))).toStrictEqual([a, b].toSorted());
  }, 20_000);

  it('keeps a decided merge that leads into a cycle, and stops where the cycle starts', async () => {
    // Xan absorbed into Ada, and Ada and Abe absorbed into each other. The
    // merge of Xan is not part of the cycle, so it still holds: Xan is Ada.
    const ada = await db.app.withBusiness(business, async (tx) => {
      const xan = await insertPerson(tx, 'Xan');
      const one = await insertPerson(tx, 'Ada');
      const two = await insertPerson(tx, 'Abe');
      const actor = await insertActor(tx, one);
      await insertIdentifier(tx, xan, 'entry@example.com', 'crm');
      await insertMerge(tx, one, xan, actor);
      await insertMerge(tx, two, one, actor);
      await insertMerge(tx, one, two, actor);
      return one;
    });
    expect(await observe('entry@example.com')).toMatchObject({
      outcome: 'attached',
      personId: ada,
    });
  }, 20_000);

  it('still resolves a plain merge to the surviving person', async () => {
    const [kit, kip] = await db.app.withBusiness(business, async (tx) => {
      const one = await insertPerson(tx, 'Kit');
      const two = await insertPerson(tx, 'Kip');
      const actor = await insertActor(tx, one);
      await insertIdentifier(tx, one, 'plain@example.com', 'crm');
      await insertIdentifier(tx, two, 'plain@example.com', 'forms');
      await insertMerge(tx, one, two, actor);
      return [one, two] as const;
    });
    expect(kip).not.toBe(kit);
    expect(await observe('plain@example.com')).toMatchObject({
      outcome: 'attached',
      personId: kit,
      person: 'existing',
    });
  }, 20_000);
});
