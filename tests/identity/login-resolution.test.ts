// SPDX-License-Identifier: AGPL-3.0-only
//
// `login_resolution`, the invariant test T1b is split against — the login half.
// The identifier half is beside it in `identifier-resolution.test.ts`, and the
// part is not landed until both pass.
//
// It passes only with T1a's wrapper: every line below reaches Postgres through
// `withBusiness`, so a resolution that worked without the business being set
// inside the transaction would have nowhere to run.
//
// The rule under test is that a refusal is a refusal. The legacy failure this
// guards against is not an exception being swallowed; it is a caller receiving
// an empty list and rendering "nothing here" to someone who should have been
// turned away at the door.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  resolveLogin,
  withSession,
  type Session,
} from '../../packages/core-records/src/identity/login-resolution.ts';
import { isRefusal, type Refusal } from '../../packages/core-records/src/identity/refusals.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'login_resolution: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const SUPABASE = 'supabase';

describe.skipIf(serverUrl === undefined)('login_resolution: the login', () => {
  let db: FreshDatabase;
  let alpha: string;
  let beta: string;
  let ada: string;

  const resolve = async (businessId: string, subject: string): Promise<Session | Refusal> =>
    await db.app.withBusiness(businessId, (tx) =>
      resolveLogin(tx, { provider: SUPABASE, subject }),
    );

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'b' });
    alpha = await insertBusiness(db.app, 'alpha');
    beta = await insertBusiness(db.app, 'beta');

    await db.app.withBusiness(alpha, async (tx) => {
      // The administrator who does the linking. Every mapping names who made
      // it, so the fixture needs one before it can map anything.
      const rootPerson = await insertPerson(tx, 'Root');
      const root = await insertActor(tx, rootPerson);
      await insertMembership(tx, rootPerson);

      // Ada: mapped, a member, and able to act.
      ada = await insertPerson(tx, 'Ada');
      await insertActor(tx, ada);
      await insertMembership(tx, ada);
      await insertMapping(tx, await insertLogin(tx, 'sub-ada'), ada, root);

      // Bo: a login the provider would verify, whose mapping was withdrawn.
      const bo = await insertPerson(tx, 'Bo');
      await insertActor(tx, bo);
      await insertMembership(tx, bo);
      await insertMapping(tx, await insertLogin(tx, 'sub-bo'), bo, root, false);

      // Cy: still mapped, no longer a member.
      const cy = await insertPerson(tx, 'Cy');
      await insertActor(tx, cy);
      await insertMembership(tx, cy, false);
      await insertMapping(tx, await insertLogin(tx, 'sub-cy'), cy, root);

      // Di: a member whose acting identity was deactivated.
      const di = await insertPerson(tx, 'Di');
      await insertActor(tx, di, false);
      await insertMembership(tx, di);
      await insertMapping(tx, await insertLogin(tx, 'sub-di'), di, root);
    });

    // The same provider subject, in another business, on another person.
    await db.app.withBusiness(beta, async (tx) => {
      const eve = await insertPerson(tx, 'Eve');
      const actor = await insertActor(tx, eve);
      await insertMembership(tx, eve);
      await insertMapping(tx, await insertLogin(tx, 'sub-ada'), eve, actor);
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  describe('a login that resolves', () => {
    it('returns the person, the acting identity and the role, and the business is the server’s', async () => {
      const session = await resolve(alpha, 'sub-ada');
      expect(isRefusal(session as object)).toBe(false);
      expect(session).toMatchObject({ businessId: alpha, personId: ada, roleKey: 'member' });
    });

    it('runs the body inside the same transaction the business was set in', async () => {
      const seen = await withSession(
        db.app,
        alpha,
        { provider: SUPABASE, subject: 'sub-ada' },
        async (tx, session) => {
          const rows = await tx.query<{ readonly value: string | null }>(
            `select current_setting('app.business_id', true) as value`,
          );
          return { setting: rows[0]?.value, personId: session.personId };
        },
      );
      expect(seen).toStrictEqual({ setting: alpha, personId: ada });
    });
  });

  describe('a login that does not', () => {
    const refusal = {
      refused: true,
      code: 'AUTH_NO_MEMBERSHIP',
      fixes: [
        'ask an administrator of this business to link this login to a person',
        'check that the business named in the request is the intended one',
      ],
    };

    it('refuses an unmapped login rather than showing it an empty result', async () => {
      expect(await resolve(alpha, 'sub-bo')).toStrictEqual(refusal);
    });

    it('refuses a login whose person is no longer a member', async () => {
      expect(await resolve(alpha, 'sub-cy')).toStrictEqual(refusal);
    });

    it('refuses a subject with no login here in exactly the same words', async () => {
      // Told apart, these two answers say whether that subject exists in this
      // business. That is the inference leak the whole tenancy argument rests
      // on closing, so the refusals are identical objects, not similar ones.
      expect(await resolve(alpha, 'sub-ghost')).toStrictEqual(refusal);
    });

    it('refuses a member whose acting identity was deactivated, and says which it is', async () => {
      expect(await resolve(alpha, 'sub-di')).toStrictEqual({
        refused: true,
        code: 'ACTOR_INACTIVE',
        fixes: ['ask an administrator of this business to reactivate this person'],
      });
    });

    it('returns the refusal rather than throwing it', async () => {
      await expect(resolve(alpha, 'sub-bo')).resolves.toHaveProperty('code');
    });

    it('carries no name, no identifier and no value the caller did not present', async () => {
      const refused = await resolve(alpha, 'sub-bo');
      expect(JSON.stringify(refused)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/u);
      expect(JSON.stringify(refused)).not.toMatch(/Bo|Ada|alpha/u);
    });

    it('does not run the body of a session it refused', async () => {
      let ran = false;
      const result = await withSession(
        db.app,
        alpha,
        { provider: SUPABASE, subject: 'sub-bo' },
        // Not an async function: there is nothing to await, and the point is
        // that it is never entered at all.
        () => {
          ran = true;
          return Promise.resolve('the body ran');
        },
      );
      expect(ran).toBe(false);
      expect(result).toStrictEqual(refusal);
    });
  });

  describe('the same subject in two businesses', () => {
    it('resolves to the person of the business that was named', async () => {
      const inAlpha = await resolve(alpha, 'sub-ada');
      const inBeta = await resolve(beta, 'sub-ada');
      expect(inAlpha).toMatchObject({ businessId: alpha, personId: ada });
      expect(inBeta).toMatchObject({ businessId: beta });
      expect((inBeta as Session).personId).not.toBe(ada);
    });

    it('refuses a business the login was never mapped in', async () => {
      const gamma = await insertBusiness(db.app, 'gamma');
      expect(await resolve(gamma, 'sub-ada')).toMatchObject({ code: 'AUTH_NO_MEMBERSHIP' });
    });
  });

  describe('what the schema refuses, so the resolver never has to', () => {
    const write = async (businessId: string, statement: string, values: readonly unknown[]) =>
      await db.app.withBusiness(businessId, (tx) => tx.query(statement, values));

    it('refuses a second active mapping for one login', async () => {
      const attempt = db.app.withBusiness(alpha, async (tx) => {
        const login = await tx.query<{ readonly id: string }>(
          `select id from logins where subject = 'sub-ada'`,
        );
        const other = await insertPerson(tx, 'Smuggled');
        const root = await insertActor(tx, other);
        await insertMapping(tx, login[0]?.id ?? '', other, root);
      });
      await expect(attempt).rejects.toThrow(/person_logins_one_active_idx/u);
    });

    it('refuses an agent actor that carries a person', async () => {
      await expect(
        write(
          alpha,
          `insert into actors (business_id, id, kind, person_id) values ($1, gen_random_uuid(), 'agent', $2)`,
          [alpha, ada],
        ),
      ).rejects.toThrow(/actors_person_kind_carries_a_person/u);
    });

    it('refuses a merge of a person into themselves', async () => {
      const attempt = db.app.withBusiness(alpha, async (tx) => {
        const actor = await tx.query<{ readonly id: string }>(
          `select id from actors where person_id = $1`,
          [ada],
        );
        await tx.query(
          `insert into person_merges
             (business_id, id, surviving_person_id, absorbed_person_id, decided_by_actor_id, evidence)
           values ($1, gen_random_uuid(), $2, $2, $3, 'no')`,
          [alpha, ada, actor[0]?.id ?? ''],
        );
      });
      await expect(attempt).rejects.toThrow(/person_merges_two_people/u);
    });

    it('refuses an identity row written into another business', async () => {
      await expect(
        write(alpha, 'insert into people (business_id, id, display_name) values ($1, $2, $3)', [
          beta,
          randomUUID(),
          'Smuggled',
        ]),
      ).rejects.toThrow(/row-level security/iu);
    });
  });
});
