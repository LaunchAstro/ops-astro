// SPDX-License-Identifier: AGPL-3.0-only
//
// `login_resolution`, the invariant test T1b is split against — the identifier
// half: an identifier matching more than one person attaches to none.
//
// The negative case is the one that matters, so it is asserted twice over: the
// call says unresolved, and the rows it could have touched are compared before
// and after to show it wrote nothing while saying so. A rule checked only
// through its own return value is a rule that survives the day that value is
// wrong.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  normaliseIdentifier,
  resolveIdentifier,
  type IdentifierResolution,
} from '../../packages/core-records/src/identity/identifier-resolution.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  countRows,
  insertActor,
  insertBusiness,
  insertIdentifier,
  insertMerge,
  insertPerson,
} from './fixture.ts';

// Narrowing rather than casting, so a test that expected one arm and got the
// other says which arm it got instead of reading a property off the wrong one.
function candidatesOf(resolution: IdentifierResolution): readonly string[] {
  if (resolution.outcome !== 'unresolved') {
    throw new Error(`expected unresolved, and it attached to ${resolution.personId}`);
  }
  return [...resolution.candidatePersonIds].toSorted();
}

function personOf(resolution: IdentifierResolution): string {
  if (resolution.outcome !== 'attached') {
    throw new Error(
      `expected an attachment, and it was unresolved between ${resolution.candidatePersonIds.length}`,
    );
  }
  return resolution.personId;
}

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'login_resolution: DATABASE_URL is unset, so the identifier half did not run and nothing is proved.',
  );
}

describe('normalising an observed identifier', () => {
  it('reads one address written two ways as one address', () => {
    expect(normaliseIdentifier('email', '  Ada@Example.COM ')).toBe('ada@example.com');
  });

  it('keeps a phone number’s digits and its country plus, and drops the punctuation', () => {
    expect(normaliseIdentifier('phone', '+61 (7) 4771-1234')).toBe('+61747711234');
    expect(normaliseIdentifier('phone', '07 4771 1234')).toBe('0747711234');
  });
});

describe.skipIf(serverUrl === undefined)('login_resolution: the identifier', () => {
  let db: FreshDatabase;
  let business: string;

  const observe = async (value: string): Promise<IdentifierResolution> =>
    await db.app.withBusiness(business, (tx) =>
      resolveIdentifier(tx, { kind: 'email', value, sourceSystem: 'import' }),
    );

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'b' });
    business = await insertBusiness(db.app, 'gamma');
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  describe('one person, or nobody yet', () => {
    it('creates a person when the identifier matches none', async () => {
      const first = await observe('new@example.com');
      expect(first).toMatchObject({ outcome: 'attached', person: 'new' });
    });

    it('attaches to that person when the identifier matches them alone', async () => {
      const first = await observe('single@example.com');
      const second = await observe('single@example.com');
      expect(second).toMatchObject({ outcome: 'attached', person: 'existing' });
      expect(personOf(second)).toBe(personOf(first));
    });

    it('moves the observation rather than accumulating rows for it', async () => {
      await observe('again@example.com');
      const before = await db.app.withBusiness(business, async (tx) => {
        const rows = await tx.query<{ readonly last_observed_at: Date }>(
          `select last_observed_at from person_identifiers where value = 'again@example.com'`,
        );
        return rows[0]?.last_observed_at;
      });
      await observe(' Again@Example.com ');
      const after = await db.app.withBusiness(business, async (tx) => {
        const rows = await tx.query<{ readonly last_observed_at: Date }>(
          `select last_observed_at from person_identifiers where value = 'again@example.com'`,
        );
        return { count: rows.length, at: rows[0]?.last_observed_at };
      });
      expect(after.count).toBe(1);
      expect(after.at?.valueOf() ?? 0).toBeGreaterThanOrEqual(before?.valueOf() ?? 0);
    });
  });

  describe('more than one person', () => {
    let ivy: string;
    let ivo: string;
    let decider: string;

    beforeAll(async () => {
      await db.app.withBusiness(business, async (tx) => {
        ivy = await insertPerson(tx, 'Ivy');
        ivo = await insertPerson(tx, 'Ivo');
        decider = await insertActor(tx, ivy);
        // Two sources, each certain, disagreeing about who lives at the
        // address. Neither is wrong; the business has not decided yet.
        await insertIdentifier(tx, ivy, 'shared@example.com', 'crm');
        await insertIdentifier(tx, ivo, 'shared@example.com', 'forms');
      });
    });

    it('attaches to none, and names both as candidates', async () => {
      const resolved = await observe('shared@example.com');
      expect(resolved.outcome).toBe('unresolved');
      expect(candidatesOf(resolved)).toStrictEqual([ivy, ivo].toSorted());
    });

    it('writes nothing at all while saying so', async () => {
      // Counting rows is not enough on its own: an attachment to one of the
      // two candidates lands on an observation that already exists and updates
      // it in place, which no count would notice. So the rows themselves are
      // compared, not how many of them there are.
      const state = async (): Promise<unknown> =>
        await db.app.withBusiness(business, async (tx) => ({
          people: await countRows(tx, 'people'),
          identifiers: await tx.query(
            `select person_id, source_system, last_observed_at, confidence
               from person_identifiers where value = 'shared@example.com'
              order by person_id`,
          ),
        }));
      const before = await state();
      await observe('shared@example.com');
      expect(await state()).toStrictEqual(before);
    });

    it('resolves once the business has decided they are one person', async () => {
      await db.app.withBusiness(business, (tx) => insertMerge(tx, ivy, ivo, decider));
      const resolved = await observe('shared@example.com');
      expect(resolved).toMatchObject({ outcome: 'attached', personId: ivy, person: 'existing' });
    });

    it('follows a merge of a merge to the last surviving person', async () => {
      const iris = await db.app.withBusiness(business, async (tx) => {
        const person = await insertPerson(tx, 'Iris');
        await insertMerge(tx, person, ivy, decider);
        return person;
      });
      expect(await observe('shared@example.com')).toMatchObject({ personId: iris });
    });

    it('is two people again once the merge is reversed', async () => {
      await db.app.withBusiness(business, async (tx) => {
        await tx.query(
          `update person_merges
              set reversed_at = now(), reversed_by_actor_id = $1,
                  reversal_evidence = 'the decision was wrong'
            where absorbed_person_id in ($2, $3)`,
          [decider, ivo, ivy],
        );
      });
      expect((await observe('shared@example.com')).outcome).toBe('unresolved');
    });
  });

  describe('a merge that points at itself', () => {
    it('stops, and arbitrates nothing', async () => {
      // Nothing stops A being absorbed into B and B into A on two separate
      // days. A chain walk over that pair does not terminate on its own.
      const [ash, asa] = await db.app.withBusiness(business, async (tx) => {
        const one = await insertPerson(tx, 'Ash');
        const two = await insertPerson(tx, 'Asa');
        const actor = await insertActor(tx, one);
        await insertIdentifier(tx, one, 'loop@example.com', 'crm');
        await insertIdentifier(tx, two, 'loop@example.com', 'forms');
        await insertMerge(tx, two, one, actor);
        await insertMerge(tx, one, two, actor);
        return [one, two] as const;
      });
      expect(candidatesOf(await observe('loop@example.com'))).toStrictEqual([ash, asa].toSorted());
    }, 20_000);
  });
});
