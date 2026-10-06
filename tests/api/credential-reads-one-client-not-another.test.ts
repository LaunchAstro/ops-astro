// SPDX-License-Identifier: AGPL-3.0-only
//
// A standing task:read credential acts within its issuer's current grants
// across clients of one business. The issuer reads the whole business when
// issuing, then keeps client A's task alone; the credential reads A and is
// refused B.

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { bearer, serverUrl, tokenFor } from '../acceptance/world.ts';
import { addClient, enrol, grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { harness, openWorld } from './api-2-agent-credential-world.ts';
import { asCredential, issued } from './api-2-agent-credential-use-world.ts';

openWorld();

/** A fresh task under a new client of alpha, titled with its canary. */
const underClient = async (canary: string) => {
  const { world } = harness;
  const clientId = randomUUID();
  await addClient(world.db.app, world.alpha, clientId, world.ada as unknown as Member);
  const task = await harness.freshTask(canary);
  const set = await harness.asPerson('task.set_party', {
    recordId: task.id,
    expectedRevision: task.revision,
    fields: { client: clientId },
  });
  expect(set.code, 'the task goes under its client').toBe('ok');
  return { clientId, taskId: task.id, canary };
};

it.skipIf(serverUrl === undefined)(
  'a standing credential reads client A’s task and is refused client B’s task once its issuer keeps access to A alone',
  async () => {
    const { world } = harness;
    const a = await underClient('AUDIT-945-CLIENT-A-CANARY');
    const b = await underClient('AUDIT-945-CLIENT-B-CANARY');

    const issuer = await enrol(world.db.app, world.alpha, 'audit945');
    const wideRead = await world.db.app.withBusiness(world.alpha, async (tx) => {
      await grantTo(tx, issuer, 'write', WHOLE_BUSINESS, false, 'credential');
      return await grantTo(tx, issuer, 'read', WHOLE_BUSINESS, false, 'task');
    });
    const token = await tokenFor(issuer.presented.subject, { secondFactor: true });
    const credential = await issued({ scope: [{ collection: 'task', action: 'read' }] }, token);

    // Committed: the issuer loses the business-wide read and keeps client A's task alone.
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      expect(await revokeGrant(tx, wideRead)).not.toBeNull();
      await grantTo(tx, issuer, 'read', { kind: 'record', id: a.taskId });
    });

    const readA = await asCredential(
      'task.read',
      { recordId: a.taskId },
      bearer(credential.secret),
    );
    expect(readA.code, 'the credential reads client A’s task').toBe('ok');
    expect(readA.text).toContain(a.canary);

    const readB = await asCredential(
      'task.read',
      { recordId: b.taskId },
      bearer(credential.secret),
    );
    expect(readB.code, 'the credential is refused client B’s task').not.toBe('ok');
    expect(readB.text, 'the refusal carries no B canary').not.toContain(b.canary);
    expect(readB.text, 'the refusal names no B task').not.toContain(b.taskId);
    expect(readB.text, 'the refusal names no B client').not.toContain(b.clientId);
  },
);
