// SPDX-License-Identifier: AGPL-3.0-only
//
// #1506 and #1507, from Sol round 2 on #1412 (criterion 1), renamed for what they
// prove and otherwise as written. An agent's task update parks on its task row while
// the delegating person's write grant is revoked; a person's `task.create` parks on
// the parent row while its write grant expires. Each must be refused and write nothing.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { connect, mintDelegation, revokeGrant } from '../../packages/core-records/src/index.ts';
import { aiWorld, created, revisionOf, type AiWorld } from './ai-assign-world.ts';
import { codeOf } from './agent-fixture.ts';
import { holdRow, waiterOf, waitPast } from '../support/lock-wait-race.ts';
import { serverUrl } from '../acceptance/world.ts';

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('owned_write_wait');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

/** A credential for the world's agent, delegated by `p` to read and write one task. */
const credentialOn = async (task: string): Promise<string> =>
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    const minted = await mintDelegation(tx, {
      agentActorId: w.world.agentActorId,
      delegatePersonId: w.p.personId,
      mintedByActorId: w.p.actorId,
      purpose: 'owned_write_wait',
      collections: ['task'],
      actions: ['read', 'write'],
      purposeScope: { kind: 'record', id: task },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!minted.ok) throw new Error(minted.refusal.code);
    return minted.value.credential;
  });

it.skipIf(serverUrl === undefined)(
  'an agent task update whose delegating write grant was revoked during its task lock wait is refused and writes nothing',
  async () => {
    const task = await created(w, w.p, 'before');
    const revision = await revisionOf(w, task);
    const credential = await credentialOn(task);
    const held = await holdRow(
      w.world.db,
      'select id from public.records where id = $1 for update',
      [task],
    );
    const revoker = connect(w.world.db.appUrl);
    const pending = w.world.asAgent(
      {
        command: 'task.update',
        operationId: randomUUID(),
        recordId: task,
        expectedRevision: revision,
        fields: { title: 'written on revoked authority' },
      },
      credential,
    );
    try {
      await waiterOf(w.world.db, held);
      await revoker.withBusiness(w.world.business, async (tx) => {
        await revokeGrant(tx, w.p.grants.write);
      });
    } finally {
      await held.letGo();
      await revoker.close();
    }
    const result = await pending;
    const [stored] = await w.world.db.admin.execute<{ title: string }>(
      'select txt_4 as title from public.records where id = $1',
      [task],
    );
    expect({ code: codeOf(result), title: stored?.title }).toEqual({
      code: 'DELEGATION_NARROWED',
      title: 'before',
    });
  },
);

it.skipIf(serverUrl === undefined)(
  'a task create whose write grant expired during its parent row wait is refused and creates nothing',
  async () => {
    const parent = await created(w, w.q, 'parent');
    const [grant] = await w.world.db.admin.execute<{ expiry: string }>(
      "update public.grants set expires_at = clock_timestamp() + interval '2 seconds' where id = $1 returning expires_at::text as expiry",
      [w.q.grants.write],
    );
    if (grant === undefined) throw new Error('no write grant');
    const held = await holdRow(
      w.world.db,
      'select id from public.records where id = $1 for update',
      [parent],
    );
    const pending = w.world.asPerson(w.q, {
      command: 'task.create',
      operationId: randomUUID(),
      parentId: parent,
      fields: { title: 'created on expired authority' },
    });
    try {
      await waiterOf(w.world.db, held);
      await waitPast(w.world.db, grant.expiry);
    } finally {
      await held.letGo();
    }
    const result = await pending;
    const rows = await w.world.db.admin.execute('select id from public.records where txt_4 = $1', [
      'created on expired authority',
    ]);
    expect({ code: codeOf(result), created: rows.length }).toEqual({
      code: 'SCOPE_NOT_GRANTED',
      created: 0,
    });
  },
);
