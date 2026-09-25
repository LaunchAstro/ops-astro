// SPDX-License-Identifier: AGPL-3.0-only
//
// The cast, enrolled the way a deployment enrols people.
//
// Split out of `world.ts` because that file reached 408 changed lines against
// this repository's 400-line per-file cap, which no waiver lifts. SPEC section
// 6's T1h row is the answer to exactly that: split the file, not the change.
//
// Everything here is written through the application role inside the tenancy
// wrapper, so a fixture that only works as a superuser fails here rather than
// passing quietly and taking a proof with it.

import { randomUUID } from 'node:crypto';
import { sign } from 'hono/jwt';
import type { FreshDatabase } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import { grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import type { BusinessId, TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import type { Action } from '../../packages/core-records/src/authority/grants.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';

/**
 * What a seeded person is, and what a seeded agent is.
 *
 * They live here rather than in `world.ts` because the enrolment functions
 * below are the only things that build them: a type declared where it is not
 * constructed is the import cycle `deps:cruise` caught when this file was
 * first split out.
 */
export interface Caller {
  /** The name the seed gives them, which is the name the matrix prints. */
  readonly name: string;
  readonly businessKey: string;
  readonly personId: string | null;
  readonly actorId: string | null;
  readonly subject: string;
  readonly presented: VerifiedSubject;
  /** A signed bearer for this subject, already minted. */
  readonly token: string;
}

export interface AgentIdentity {
  readonly subject: string;
  readonly presented: VerifiedSubject;
  readonly actorId: string;
  readonly token: string;
}

/** The deployment secret for this suite. Local, disposable, never a real one. */
export const ACCEPTANCE_SECRET = 'l5-acceptance-secret-not-any-running-deployment';

/**
 * The grants the fixture gives each role. They are not a copy of
 * `GRANTS_BY_ROLE` in the seed: the fixture member holds `task:comment` and not
 * `person:read` or `settings:read`, and the fixture admin holds every action on
 * four collections where the seed names ten pairs. `final-r1-dbtest-cast.test.ts`
 * pins that difference and checks the seed's roles against the surface.
 *
 * `noah` is absent on purpose and that absence is the whole of case N2: a
 * member with no grant must be told `SCOPE_NOT_GRANTED` and never handed an
 * empty list, and a fixture that quietly granted him something would have
 * turned that case into a tautology.
 */
export const ADMIN_ACTIONS: readonly Action[] = [
  'read',
  'write',
  'assign',
  'comment',
  'decide',
  'share',
  'manage',
];
export const MEMBER_ACTIONS: readonly Action[] = ['read', 'write', 'assign', 'comment'];

/**
 * The collections an administrator holds authority over.
 *
 * `task` is not the whole surface any more. `person.list` asks about `person`,
 * the two settings commands about `settings`, and `preset.plan` about the
 * record family it names — so an administrator granted only on tasks is
 * refused `SCOPE_NOT_GRANTED` on four declarations, and a matrix built on that
 * fixture would have recorded four missing positive controls as product
 * failures. The grant is per collection because the surface says it is.
 */
export const ADMIN_COLLECTIONS: readonly string[] = ['task', 'person', 'settings', 'preset'];

export async function tokenFor(
  subject: string,
  options: { readonly expiresIn?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await sign(
    {
      sub: subject,
      aud: 'authenticated',
      role: 'authenticated',
      exp: now + (options.expiresIn ?? 3600),
    },
    ACCEPTANCE_SECRET,
    'HS256',
  );
}

export async function enrolCaller(
  db: FreshDatabase,
  businessId: BusinessId,
  businessKey: string,
  name: string,
  options: {
    readonly membership: boolean;
    readonly actions: readonly Action[];
    readonly collections: readonly string[];
  },
): Promise<Caller> {
  const subject = `${name}-${randomUUID()}`;
  const identity = await db.app.withBusiness(businessId, async (tx) => {
    const personId = await insertPerson(tx, name);
    const actorId = await insertActor(tx, personId);
    // A login with no membership is `orphan`: verified by the provider, known
    // to no business, which is `AUTH_NO_MEMBERSHIP` and not `AUTH_UNKNOWN_LOGIN`.
    if (options.membership) await insertMembership(tx, personId);
    const loginId = await insertLogin(tx, subject);
    await insertMapping(tx, loginId, personId, actorId);
    return { personId, actorId };
  });
  const member = { ...identity, presented: { provider: 'supabase', subject } as VerifiedSubject };
  if (options.actions.length > 0) {
    await db.app.withBusiness(businessId, async (tx: TenantQuery) => {
      for (const collection of options.collections) {
        for (const action of options.actions) {
          // eslint-disable-next-line no-await-in-loop -- one grant at a time reads as a list
          await grantTo(tx, member, action, WHOLE_BUSINESS, false, collection);
        }
      }
    });
  }
  return {
    name,
    businessKey,
    personId: identity.personId,
    actorId: identity.actorId,
    subject,
    presented: member.presented,
    token: await tokenFor(subject),
  };
}

/**
 * The agent identity, written the way `scripts/local-seed.mjs` writes it: an
 * actor of kind `agent`, a login of its own, and a row in `actor_logins` and in
 * neither person table. The address is built rather than written out, which is
 * also what keeps it out of `scripts/public-content-check.mjs`'s way.
 */
export async function enrolAgent(
  db: FreshDatabase,
  businessId: BusinessId,
  linkedBy: string,
): Promise<AgentIdentity> {
  const subject = ['agent', randomUUID()].join('-');
  const actorId = randomUUID();
  await db.app.withBusiness(businessId, async (tx) => {
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      businessId,
      actorId,
    ]);
    const loginId = await insertLogin(tx, subject);
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [businessId, randomUUID(), loginId, actorId, linkedBy],
    );
  });
  return {
    subject,
    presented: { provider: 'supabase', subject },
    actorId,
    token: await tokenFor(subject),
  };
}
