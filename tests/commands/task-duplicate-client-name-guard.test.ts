// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8 task.duplicate: the carried-text guard names the old client only to a
// caller who may read it, and a duplicate with no steps is empty.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantTo } from './fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import {
  CLIENT_A_NAME,
  alpha,
  as,
  clientA,
  clientB,
  db,
  detailOf,
  duplicate,
  newTaskOf,
  outcomeOf,
  owner,
  person,
  revisionOf,
  serverUrl,
  setUp,
  taskFor,
  tearDown,
} from './duplicate-world.ts';

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

describe.skipIf(serverUrl === undefined)(
  'MP-4-8 duplicate: the client name guard and the empty duplicate',
  () => {
    it('the carried-text guard is no oracle for a client name the caller cannot read', async () => {
      // The old task's own text never names its client.
      const old = await taskFor(alpha, owner, 'Spring work', clientA);
      const prober = await person('prober');
      await db.app.withBusiness(alpha, async (tx) => {
        await grantTo(tx, prober, 'read', { kind: 'record', id: old });
        await grantTo(tx, prober, 'write', { kind: 'party', id: clientB });
        await grantTo(tx, prober, 'share', { kind: 'party', id: clientB });
      });
      // The prober is not shown client A's name anywhere it may read.
      const clients = await executeRead(db.app, alpha, prober.presented, {
        read: 'client.list',
      } as never);
      expect(JSON.stringify(clients)).not.toContain(CLIENT_A_NAME);
      expect(JSON.stringify(await detailOf(prober, old))).not.toContain(CLIENT_A_NAME);
      // Guesses, one per step name; the answer must not single out the right one.
      const answer = await duplicate(prober, {
        recordId: old,
        client: clientB,
        title: 'probe',
        stepNames: ['Acme Plumbing', CLIENT_A_NAME, 'Zeta Studio'],
      });
      expect(outcomeOf(answer)).not.toStrictEqual({
        code: 'CARRIED_TEXT_NAMES_CLIENT',
        names: ['stepNames.1'],
      });
    });

    it('a duplicate with no steps is empty, so its client still changes in one step', async () => {
      const old = await taskFor(alpha, owner, 'Locked old', clientA);
      await as(alpha, owner, {
        command: 'task.update',
        recordId: old,
        expectedRevision: await revisionOf(old),
        fields: { description: 'content' },
      });
      const { taskId } = newTaskOf(
        await duplicate(owner, { recordId: old, client: clientB, title: 'fresh', stepNames: [] }),
      );
      const moved = await as(alpha, owner, {
        command: 'task.set_party',
        recordId: taskId,
        expectedRevision: await revisionOf(taskId),
        fields: { client: clientA },
      });
      expect(outcomeOf(moved)).toStrictEqual({ applied: true });
    });
  },
);
