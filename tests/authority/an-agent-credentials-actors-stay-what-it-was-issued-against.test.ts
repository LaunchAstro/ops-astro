// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent credential is held by an agent actor and issued by the issuing
// person's actor (`agent_credentials_held_by_an_agent`, 20261012133600). The
// insert reads both actor rows `for share`, so a change to either that has
// not committed is waited on and judged once it settles: committed, the
// insert is refused; rolled back, it is stored. Each writer has a connection
// of its own, since one pool of one would queue the second behind the first
// and prove nothing.
//
// Once the credential is stored, the actor rows are still the application's
// to update (0002 grants update on `actors`), so the agent can become a worker
// and the issuer an agent, and the credential then speaks for a non-agent.
// The product never changes an actor's kind or person.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { openSchedules, racer, type Schedules } from '../runtime/schedules-harness.ts';
import { enrol, type Member } from '../commands/fixture.ts';
import { waitingOn } from '../automations/race-hold.ts';

const noDatabase = process.env['DATABASE_URL'] === undefined;

let s: Schedules;
beforeAll(async () => {
  if (!noDatabase) s = await openSchedules('credactors', 1_000_000);
}, 180_000);
afterAll(async () => {
  await s?.db.drop();
});

const anAgent = async (): Promise<string> => {
  const id = randomUUID();
  await s.db.app.withBusiness(s.business, async (tx) => {
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      s.business,
      id,
    ]);
  });
  return id;
};

const issue = async (agentActorId: string, issuer: Member = s.decider) =>
  await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await tx.query(
        `insert into public.agent_credentials
           (business_id, id, agent_actor_id, issued_by_person_id, issued_by_actor_id, purpose, scope,
            credential_hash, credential_scheme, credential_key_id, expires_at)
         values ($1, $2, $3, $4, $5, 'triage', array['task:read'], $6, 'hmac-sha256-v1', 'k1',
                 now() + interval '1 day')`,
        [s.business, randomUUID(), agentActorId, issuer.personId, issuer.actorId, 'a'.repeat(64)],
      ),
  );

const TO_WORKER = `update public.actors set kind = 'worker', display_name = null, owner_person_id = null
  where id = $1`;

const admin = (sql: string, params: readonly unknown[]) => s.db.admin.execute(sql, params);

/** The insert sent while another connection holds `TO_WORKER` uncommitted, then `settle` ends it. */
async function issuedWhileChanging(agent: string, settle: 'commit' | 'rollback') {
  const changer = racer(s);
  const rollback = new Error('the actor change rolls back');
  let sent: Promise<PromiseSettledResult<unknown>> | undefined;
  try {
    await changer.withBusiness(s.business, async (tx) => {
      await tx.query(TO_WORKER, [agent]);
      sent = issue(agent).then(
        (value) => ({ status: 'fulfilled', value }) as const,
        (reason: unknown) => ({ status: 'rejected', reason }) as const,
      );
      await waitingOn(admin, 1);
      if (settle === 'rollback') throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    await changer.close();
  }
  return await sent;
}

it.skipIf(noDatabase)(
  'a credential issued while its agent is being made a worker waits, and is refused once the change commits, then again on retry',
  async () => {
    const agent = await anAgent();
    expect(await issuedWhileChanging(agent, 'commit')).toMatchObject({
      status: 'rejected',
      reason: { code: '23514' },
    });
    await expect(issue(agent)).rejects.toMatchObject({ code: '23514' });
  },
);

it.skipIf(noDatabase)(
  'a credential issued while its agent is being made a worker is stored once that change rolls back',
  async () => {
    const agent = await anAgent();
    expect(await issuedWhileChanging(agent, 'rollback')).toMatchObject({ status: 'fulfilled' });
    const [stored] = await s.db.admin.execute<{ n: number }>(
      `select count(*)::int as n from public.agent_credentials c
         join public.actors a on a.business_id = c.business_id and a.id = c.agent_actor_id
        where c.agent_actor_id = $1 and a.kind = 'agent'`,
      [agent],
    );
    expect(stored?.n).toBe(1);
  },
);

it.skipIf(noDatabase)(
  'an actor holding or issuing a credential keeps the kind and person it was issued against',
  async () => {
    const agent = await anAgent();
    const issuer = await enrol(s.db.app, s.business, 'issuer');
    await issue(agent);
    await issue(await anAgent(), issuer);
    const changed = await Promise.allSettled([
      s.db.app.withBusiness(s.business, async (tx) => await tx.query(TO_WORKER, [agent])),
      s.db.app.withBusiness(
        s.business,
        async (tx) =>
          await tx.query(
            `update public.actors set kind = 'agent', person_id = null where id = $1`,
            [issuer.actorId],
          ),
      ),
    ]);
    expect(changed).toMatchObject([
      { status: 'rejected', reason: { code: '23514' } },
      { status: 'rejected', reason: { code: '23514' } },
    ]);
  },
);
