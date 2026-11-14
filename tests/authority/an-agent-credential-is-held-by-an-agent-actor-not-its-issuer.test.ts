// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent credential is held by an agent. The table checked the agent's id
// only as an actor of the business, so a person actor, the issuer's own
// included, could be stored as the agent a credential speaks for. The rows are
// written as the application role, the role a bug or an injected statement in
// the product would write them as.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { openSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { enrol } from '../commands/fixture.ts';

const noDatabase = process.env['DATABASE_URL'] === undefined;

let s: Schedules;
beforeAll(async () => {
  if (!noDatabase) s = await openSchedules('credagentkind', 1_000_000);
}, 180_000);
afterAll(async () => {
  await s?.db.drop();
});

const issue = async (agentActorId: string) =>
  await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await tx.query(
        `insert into public.agent_credentials
           (business_id, id, agent_actor_id, issued_by_person_id, issued_by_actor_id, purpose, scope,
            credential_hash, credential_scheme, credential_key_id, expires_at)
         values ($1, $2, $3, $4, $5, 'triage', array['task:read'], $6, 'hmac-sha256-v1', 'k1',
                 now() + interval '1 day')`,
        [
          s.business,
          randomUUID(),
          agentActorId,
          s.decider.personId,
          s.decider.actorId,
          'a'.repeat(64),
        ],
      ),
  );

it.skipIf(noDatabase)(
  'a credential naming a person actor, or its own issuer, as the agent is refused',
  async () => {
    const colleague = await enrol(s.db.app, s.business, 'colleague');
    const written = await Promise.allSettled([issue(s.decider.actorId), issue(colleague.actorId)]);
    expect(written).toMatchObject([
      { status: 'rejected', reason: { code: '23514' } },
      { status: 'rejected', reason: { code: '23514' } },
    ]);
  },
);

it.skipIf(noDatabase)('a credential naming an agent actor is stored', async () => {
  await expect(issue(s.agentActorId)).resolves.toBeDefined();
});
