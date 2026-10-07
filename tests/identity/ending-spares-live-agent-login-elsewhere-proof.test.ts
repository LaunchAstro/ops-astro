// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createGoTrueLogins } from '../../apps/api/auth/logins.ts';
import { settleAccessEndings } from '../../packages/core-commands/src/commands/access-end.ts';
import { resolveAgentLogin } from '../../packages/core-records/src/identity/agent-login.ts';
import { loginLiveElsewhere } from '../../packages/core-records/src/identity/shared-login.ts';
import { createFreshDatabase } from '../support/fresh-database.ts';
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

it('ending a person in one business preserves a live agent login in another business', async () => {
  const db = await createFreshDatabase({ part: 'sold3agent' });
  try {
    const alpha = await insertBusiness(db.app, 'sol-alpha');
    const bravo = await insertBusiness(db.app, 'sol-bravo');
    const subject = randomUUID();
    await db.app.withBusiness(alpha, async (tx) => {
      const person = await insertPerson(tx, 'Ended alpha person');
      const actor = await insertActor(tx, person);
      const login = await insertLogin(tx, subject);
      await insertMembership(tx, person, false);
      await insertMapping(tx, login, person, actor);
      await tx.query(
        `insert into public.access_endings (business_id, person_id, login_id, ended_by_actor_id)
         values ($1, $2, $3, $4)`,
        [alpha, person, login, actor],
      );
    });
    const agentId = await db.app.withBusiness(bravo, async (tx) => {
      const agent = await insertAgentActor(tx);
      await insertAgentMapping(tx, await insertLogin(tx, subject), agent, agent);
      return agent;
    });
    const session = await db.app.withBusiness(bravo, async (tx) =>
      await resolveAgentLogin(tx, { provider: 'supabase', subject }),
    );
    expect(session).toMatchObject({ businessId: bravo, kind: 'agent', actorId: agentId });
    const calls: string[] = [];
    const provider = createGoTrueLogins({
      baseUrl: 'http://127.0.0.1:9/auth/v1',
      adminKey: () => Promise.resolve('sol-synthetic-service-key'),
      fetch: async (url) => {
        calls.push(String(url));
        return Response.json({ id: subject, banned_until: '2999-01-01T00:00:00Z' });
      },
    });
    const report = await settleAccessEndings(db.app, alpha, provider, {
      sharedElsewhere: async (user) => await loginLiveElsewhere(db.admin, user, alpha),
    });
    expect(report).toMatchObject({ settled: 1, owed: 0 });
    expect(calls, 'a provider-wide ban would revoke the still-live bravo agent login').toEqual([]);
  } finally {
    await db.drop();
  }
});
