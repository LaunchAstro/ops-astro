// SPDX-License-Identifier: AGPL-3.0-only
//
// API-2: `session.capabilities` under an agent credential (ORCH47). The answer
// is the credential's own: the keys its person ticked that the person's grants
// still cover right now, and the agent actor as the acting identity. A key
// the person holds and did not tick is not listed, and neither is a ticked key
// revoked from the person since. Noah holds `task:read`, `task:write` and
// `credential:write` from the world, and `task:comment` from this file; this
// file revokes his `task:write`, so it has a world of its own.

import { beforeAll, expect, it } from 'vitest';
import { revokeGrant } from '../../packages/core-records/src/index.ts';
import { grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import { bearer, serverUrl, type Answer } from '../acceptance/world.ts';
import { harness, openWorld } from './api-2-agent-credential-world.ts';
import { asCredential, issued } from './api-2-agent-credential-use-world.ts';

openWorld();

const needsServer = it.skipIf(serverUrl === undefined);
let taskWrite: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  const noah = harness.world.noah as unknown as Member;
  await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
    await grantTo(tx, noah, 'comment', WHOLE_BUSINESS, false, 'task');
  });
  const rows = await harness.world.db.admin.execute<{ readonly id: string }>(
    `select id from public.grants
      where subject_kind = 'person' and subject_id = $1 and collection = 'task'
        and action = 'write' and revoked_at is null`,
    [harness.world.noah.personId],
  );
  expect(rows).toHaveLength(1);
  taskWrite = String(rows[0]?.id);
});

const pairsOf = (answer: Answer): string[] =>
  ((answer.body['grants'] ?? []) as readonly { collection: string; action: string }[]).map(
    (one) => `${one.collection}:${one.action}`,
  );

async function agentActorOf(credentialId: string): Promise<string> {
  const rows = await harness.world.db.admin.execute<{ readonly agent_actor_id: string }>(
    'select agent_actor_id from public.agent_credentials where id = $1',
    [credentialId],
  );
  return String(rows[0]?.agent_actor_id);
}

needsServer(
  "API-2 capabilities: session.capabilities under a credential answers the credential's keys within the person's live grants, and the agent as acting identity",
  async () => {
    const asNoah = await harness.asPerson('session.capabilities', {}, 'alpha', harness.world.noah);
    expect(asNoah.code, asNoah.text).toBe('ok');
    expect(pairsOf(asNoah)).toStrictEqual([
      'credential:write',
      'task:comment',
      'task:read',
      'task:write',
    ]);

    const credential = await issued(
      {
        scope: [
          { collection: 'task', action: 'read' },
          { collection: 'task', action: 'write' },
        ],
      },
      harness.world.noah.token,
    );
    const ask = async (): Promise<Answer> =>
      await asCredential('session.capabilities', {}, bearer(credential.secret));

    const asked = await ask();
    expect(asked.code, asked.text).toBe('ok');
    expect(pairsOf(asked), 'the ticked keys, not every key Noah holds').toStrictEqual([
      'task:read',
      'task:write',
    ]);
    expect(asked.body['agentActorId']).toBe(await agentActorOf(credential.id));
    expect(asked.body['agentActorId']).not.toBe(harness.world.noah.actorId);
    expect(asked.body['personId'], 'the person it acts for').toBe(harness.world.noah.personId);
    expect(asked.body['businessKey']).toBe('alpha');
    expect(asked.text).not.toContain(credential.secret);

    await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
      expect(await revokeGrant(tx, taskWrite)).not.toBeNull();
    });
    const narrowed = await ask();
    expect(narrowed.code, narrowed.text).toBe('ok');
    expect(pairsOf(narrowed), 'a ticked key revoked from Noah is gone').toStrictEqual([
      'task:read',
    ]);
  },
);
