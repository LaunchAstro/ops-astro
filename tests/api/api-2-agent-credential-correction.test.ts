// SPDX-License-Identifier: AGPL-3.0-only
//
// API-2 and C80: a standing agent credential cannot request a live correction.
// The permissions table gives an agent `run:write` only inside its delegation,
// and a credential's delegation is a pickup's, for one task. A credential that
// ticks task:read and run:write, issued by a person who holds both
// business-wide, is refused on the agent route before any command code, and
// no correction is stored for its agent actor.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import { clientHere } from '../reads/client-rows.ts';
import { requestBody } from '../site/c80-world.ts';
import { bearer, serverUrl } from '../acceptance/world.ts';
import { harness, openWorld } from './api-2-agent-credential-world.ts';
import { asCredential, issued } from './api-2-agent-credential-use-world.ts';

openWorld();

const needsServer = it.skipIf(serverUrl === undefined);
let partyId = '';

const corrections = async (): Promise<number> => {
  const rows = await harness.world.db.admin.execute<{ readonly n: string }>(
    'select count(*)::text as n from public.live_corrections where business_id = $1',
    [harness.world.alpha],
  );
  return Number(rows[0]?.n ?? '-1');
};

beforeAll(async () => {
  if (serverUrl === undefined) return;
  const { world } = harness;
  partyId = await clientHere(world.db.admin, world.alpha, randomUUID());
  // The task is the client's, so a correction under it would be stored.
  await world.db.admin.execute('update public.records set uuid_7 = $1 where id = $2', [
    partyId,
    harness.alphaTask.id,
  ]);
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await grantTo(tx, world.ada as unknown as Member, 'write', WHOLE_BUSINESS, false, 'run');
  });
});

needsServer(
  'a standing credential with task:read and run:write is refused a live correction, and nothing is stored',
  async () => {
    const credential = await issued({
      scope: [
        { collection: 'task', action: 'read' },
        { collection: 'run', action: 'write' },
      ],
    });
    const { command: _command, ...body } = requestBody(partyId, harness.alphaTask.id);
    const answer = await asCredential('live_correction.request', body, bearer(credential.secret));
    expect(answer.code).toBe('DELEGATION_EXCLUDES_OPERATION');
    expect(answer.text).not.toContain('correctionId');
    expect(await corrections()).toBe(0);
  },
);
