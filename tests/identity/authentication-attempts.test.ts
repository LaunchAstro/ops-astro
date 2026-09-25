// SPDX-License-Identifier: AGPL-3.0-only
//
// I13's separate authentication-attempt owner: every attempt at the door is
// recorded, the successes and the refusals, and the refusals carry no subject.
//
// The failure this guards against is the ordinary one. A login path returns a
// refusal, the caller renders it, and nothing anywhere says that somebody
// presented a credential this business has never seen — which is the only
// signal a repeated attempt produces.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  readAuthenticationAttempts,
  subjectDigest,
} from '../../packages/core-records/src/identity/authentication-attempts.ts';
import { resolveAgentLogin } from '../../packages/core-records/src/identity/agent-login.ts';
import { resolveLogin } from '../../packages/core-records/src/identity/login-resolution.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  insertActor,
  insertAgentActor,
  insertAgentMapping,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
const PROVIDER = 'supabase';

describe.skipIf(serverUrl === undefined)('every authentication attempt is recorded', () => {
  let db: FreshDatabase;
  let business: string;
  let adaPerson: string;
  let adaActor: string;
  let agentActor: string;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'l2a' });
    business = await insertBusiness(db.app, 'alpha');
    await db.app.withBusiness(business, async (tx) => {
      adaPerson = await insertPerson(tx, 'Ada');
      adaActor = await insertActor(tx, adaPerson);
      await insertMembership(tx, adaPerson);
      const adaLogin = await insertLogin(tx, 'ada-subject');
      await insertMapping(tx, adaLogin, adaPerson, adaActor);
      agentActor = await insertAgentActor(tx);
      const agentLogin = await insertLogin(tx, 'agent-subject');
      await insertAgentMapping(tx, agentLogin, agentActor, adaActor);
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  const attempts = async (subject: string) =>
    await db.app.withBusiness(business, async (tx) =>
      readAuthenticationAttempts(tx, { provider: PROVIDER, subject }),
    );

  it('records a resolved person login against its verified subject', async () => {
    await db.app.withBusiness(business, async (tx) => {
      await resolveLogin(tx, { provider: PROVIDER, subject: 'ada-subject' });
    });
    const [row] = await attempts('ada-subject');
    expect(row?.outcome).toBe('resolved');
    expect(row?.owner).toBe('person_login');
    expect(row?.actor_id).toBe(adaActor);
    expect(row?.person_id).toBe(adaPerson);
    expect(row?.refusal_code).toBeNull();
  });

  it('records a refused person login with its reason and no subject', async () => {
    const unknown = randomUUID();
    await db.app.withBusiness(business, async (tx) => {
      await resolveLogin(tx, { provider: PROVIDER, subject: unknown });
    });
    const [row] = await attempts(unknown);
    expect(row?.outcome).toBe('refused');
    expect(row?.refusal_code).toBe('AUTH_NO_MEMBERSHIP');
    expect(row?.login_id).toBeNull();
    expect(row?.actor_id).toBeNull();
    expect(row?.person_id).toBeNull();
  });

  it('records the agent path under its own owner', async () => {
    await db.app.withBusiness(business, async (tx) => {
      await resolveAgentLogin(tx, { provider: PROVIDER, subject: 'agent-subject' });
    });
    const [row] = await attempts('agent-subject');
    expect(row?.owner).toBe('agent_login');
    expect(row?.outcome).toBe('resolved');
    expect(row?.actor_id).toBe(agentActor);
    expect(row?.person_id).toBeNull();
  });

  it('stores the presented subject as a digest and never whole', async () => {
    const unknown = randomUUID();
    await db.app.withBusiness(business, async (tx) => {
      await resolveAgentLogin(tx, { provider: PROVIDER, subject: unknown });
    });
    const [row] = await attempts(unknown);
    expect(row?.subject_digest).toBe(subjectDigest({ provider: PROVIDER, subject: unknown }));
    expect(row?.subject_digest).not.toContain(unknown);
    const raw = await db.app.withBusiness(business, async (tx) =>
      tx.query<{ readonly n: string }>(
        `select count(*)::text as n from authentication_attempts
          where business_id = $1 and subject_digest = $2`,
        [business, unknown],
      ),
    );
    expect(raw[0]?.n).toBe('0');
  });

  it('is append only: the application role may not amend a recorded attempt', async () => {
    await expect(
      db.app.withBusiness(business, async (tx) => {
        await tx.query(
          `update authentication_attempts set outcome = 'resolved' where business_id = $1`,
          [business],
        );
      }),
    ).rejects.toThrow(/permission denied/iu);
  });

  it('counts one row per attempt, so a repeated refusal is visible as repetition', async () => {
    const unknown = randomUUID();
    for (const _ of [0, 1, 2]) {
      // eslint-disable-next-line no-await-in-loop
      await db.app.withBusiness(business, async (tx) => {
        await resolveLogin(tx, { provider: PROVIDER, subject: unknown });
      });
    }
    expect((await attempts(unknown)).length).toBe(3);
  });
});
