// SPDX-License-Identifier: AGPL-3.0-only
//
// The external party's half of login resolution (I01, R4).
//
// Minimum contract 8.1 names R4 as a business A external party holding a
// record-scoped grant on one task, and 1.3 step 2 makes `AUTH_NO_MEMBERSHIP`
// the refusal for a login with no active *person mapping*. So a mapped person
// with no membership is not refused for that alone: what they may reach is
// their shares. What must not follow from it is the reverse door, a former
// member whose business-wide grants outlived the membership. Those cases are
// here, each one against a real migrated database through `withBusiness`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  resolveLogin,
  type Session,
} from '../../packages/core-records/src/identity/login-resolution.ts';
import { isRefusal, type Refusal } from '../../packages/core-records/src/identity/refusals.ts';
import { issueGrant, revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
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
    'external_party: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

describe.skipIf(serverUrl === undefined)('login_resolution: the external party', () => {
  let db: FreshDatabase;
  let alpha: string;
  let root: string;

  const resolve = async (subject: string): Promise<Session | Refusal> =>
    await db.app.withBusiness(alpha, (tx) => resolveLogin(tx, { provider: 'supabase', subject }));

  /** A mapped person, with or without a membership, and their subject. */
  const person = async (
    tx: TenantQuery,
    name: string,
    options: { membership: 'none' | 'active' | 'ended'; actorActive?: boolean },
  ): Promise<{ personId: string; subject: string }> => {
    const personId = await insertPerson(tx, name);
    await insertActor(tx, personId, options.actorActive ?? true);
    if (options.membership !== 'none') {
      await insertMembership(tx, personId, options.membership === 'active');
    }
    const subject = `sub-${name}-${randomUUID()}`;
    await insertMapping(tx, await insertLogin(tx, subject), personId, root);
    return { personId, subject };
  };

  /** A root grant on one record, through the authority module's own issue path. */
  const share = async (
    tx: TenantQuery,
    personId: string,
    scope: { kind: 'record' | 'business'; id: string | null },
    expiresAt: Date | null = null,
  ): Promise<string> => {
    const issued = await issueGrant(tx, [], {
      subject: { kind: 'person', id: personId },
      scope,
      collection: 'task',
      action: 'read',
      parentGrantId: null,
      grantedByActorId: root,
      expiresAt,
    });
    if (!issued.ok) throw new Error(`fixture: grant refused ${issued.refusal.code}`);
    return issued.value;
  };

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'r4_identity' });
    alpha = await insertBusiness(db.app, 'alpha');
    await db.app.withBusiness(alpha, async (tx) => {
      const rootPerson = await insertPerson(tx, 'Root');
      root = await insertActor(tx, rootPerson);
      await insertMembership(tx, rootPerson);
    });
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('a mapped non-member holding a live record share resolves, with no role', async () => {
    const ext = await db.app.withBusiness(alpha, async (tx) => {
      const made = await person(tx, 'ext', { membership: 'none' });
      await share(tx, made.personId, { kind: 'record', id: randomUUID() });
      return made;
    });
    const resolved = await resolve(ext.subject);
    expect(isRefusal(resolved)).toBe(false);
    const session = resolved as Session;
    expect(session.personId).toBe(ext.personId);
    expect(session.roleKey).toBeNull();
  });

  it('a mapped non-member with no share is AUTH_NO_MEMBERSHIP, exactly as before', async () => {
    const bare = await db.app.withBusiness(alpha, (tx) =>
      person(tx, 'bare', { membership: 'none' }),
    );
    expect(await resolve(bare.subject)).toMatchObject({ code: 'AUTH_NO_MEMBERSHIP' });
  });

  it('a revoked or expired share confers nothing', async () => {
    const [revoked, expired] = await db.app.withBusiness(alpha, async (tx) => {
      const first = await person(tx, 'revoked', { membership: 'none' });
      await revokeGrant(tx, await share(tx, first.personId, { kind: 'record', id: randomUUID() }));
      const second = await person(tx, 'expired', { membership: 'none' });
      const past = new Date(Date.now() - 60_000);
      await share(tx, second.personId, { kind: 'record', id: randomUUID() }, past);
      return [first, second];
    });
    expect(await resolve(revoked.subject)).toMatchObject({ code: 'AUTH_NO_MEMBERSHIP' });
    expect(await resolve(expired.subject)).toMatchObject({ code: 'AUTH_NO_MEMBERSHIP' });
  });

  it('a former member whose business grant outlived the membership stays refused', async () => {
    const former = await db.app.withBusiness(alpha, async (tx) => {
      const made = await person(tx, 'former', { membership: 'ended' });
      await share(tx, made.personId, { kind: 'business', id: null });
      await share(tx, made.personId, { kind: 'record', id: randomUUID() });
      return made;
    });
    expect(await resolve(former.subject)).toMatchObject({ code: 'AUTH_NO_MEMBERSHIP' });
  });

  it('an external party whose actor is deactivated is ACTOR_INACTIVE', async () => {
    const gone = await db.app.withBusiness(alpha, async (tx) => {
      const made = await person(tx, 'gone', { membership: 'none', actorActive: false });
      await share(tx, made.personId, { kind: 'record', id: randomUUID() });
      return made;
    });
    expect(await resolve(gone.subject)).toMatchObject({ code: 'ACTOR_INACTIVE' });
  });

  it('a member still resolves with their role key', async () => {
    const member = await db.app.withBusiness(alpha, (tx) =>
      person(tx, 'member', { membership: 'active' }),
    );
    expect(await resolve(member.subject)).toMatchObject({ roleKey: 'member' });
  });
});
