// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent credential's agent stays an agent against an application
// transaction whose repeatable-read snapshot predates the credential, and the
// credential guard keeps business and issuing-person separation (#649).
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { openSchedules, type Schedules } from '../runtime/schedules-harness.ts';

let s: Schedules;
beforeAll(async () => {
  s = await openSchedules('oldsnapshot', 1_000_000);
}, 180_000);
afterAll(async () => {
  await s?.db.drop();
});

it('an application transaction on a snapshot older than the credential cannot turn its agent into a worker', async () => {
  const agent = randomUUID();
  await s.db.app.withBusiness(s.business, async (tx) => {
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      s.business,
      agent,
    ]);
  });
  const sql = postgres(s.db.appUrl, { max: 1, onnotice: () => {} });
  let issued = false;
  try {
    const outcome = await sql
      .begin('isolation level repeatable read', async (tx) => {
        await tx.unsafe(`select set_config('app.business_id', $1, true)`, [s.business]);
        await tx.unsafe('select 1 from public.agent_credentials');
        await s.db.app.withBusiness(s.business, async (writer) => {
          await writer.query(
            `insert into public.agent_credentials
          (business_id,id,agent_actor_id,issued_by_person_id,issued_by_actor_id,purpose,scope,
           credential_hash,credential_scheme,credential_key_id,expires_at)
          values ($1,$2,$3,$4,$5,'proof',array['task:read'],repeat('a',64),'hmac-sha256-v1','proof',now()+interval '1 day')`,
            [s.business, randomUUID(), agent, s.decider.personId, s.decider.actorId],
          );
        });
        issued = true;
        await tx.unsafe(
          `update public.actors set kind = 'worker', display_name = null, owner_person_id = null where id = $1`,
          [agent],
        );
        return 'committed';
      })
      .catch((error) => {
        if (error.code === '23514' || error.code === '40001') return String(error.code);
        throw error;
      });
    expect(issued).toBe(true);
    const stored = await s.db.admin.execute(
      'select 1 from public.agent_credentials where agent_actor_id = $1',
      [agent],
    );
    expect(stored).toHaveLength(1);
    const invalid = await s.db.admin.execute(
      `select 1 from public.agent_credentials c join public.actors a
      on a.business_id=c.business_id and a.id=c.agent_actor_id where a.id=$1 and a.kind <> 'agent'`,
      [agent],
    );
    expect({ outcome, invalid: invalid.length }).toMatchObject({ invalid: 0 });
  } finally {
    await sql.end();
  }
});

it('the credential guard keeps business and issuing-person separation', async () => {
  const { seedSchedules } = await import('../runtime/schedules-harness.ts');
  const { enrol } = await import('../commands/fixture.ts');
  const foreign = await seedSchedules(s.db, 'oldsnapforeign', 1_000_000);
  const colleague = await enrol(s.db.app, s.business, 'colleague');
  const insert = (business: string, agent: string, person: string, issuer: string) =>
    s.db.app.withBusiness(
      s.business,
      async (tx) =>
        await tx.query(
          `insert into public.agent_credentials
      (business_id,id,agent_actor_id,issued_by_person_id,issued_by_actor_id,purpose,scope,
       credential_hash,credential_scheme,credential_key_id,expires_at)
      values ($1,$2,$3,$4,$5,'separation',array['task:read'],repeat('b',64),'hmac-sha256-v1','proof',now()+interval '1 day')`,
          [business, randomUUID(), agent, person, issuer],
        ),
    );
  await expect(
    insert(
      foreign.business,
      foreign.agentActorId,
      foreign.decider.personId,
      foreign.decider.actorId,
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    insert(s.business, foreign.agentActorId, s.decider.personId, s.decider.actorId),
  ).rejects.toBeDefined();
  await expect(
    insert(s.business, s.agentActorId, colleague.personId, s.decider.actorId),
  ).rejects.toMatchObject({ code: '23514', constraint_name: 'agent_credentials_held_by_an_agent' });
});
