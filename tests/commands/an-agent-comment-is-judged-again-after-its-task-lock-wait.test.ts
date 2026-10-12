// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  connect,
  lockAccess,
  mintDelegation,
  resolveDelegation,
  revokeGrant,
} from '../../packages/core-records/src/index.ts';
import { aiWorld, created, type AiWorld } from './ai-assign-world.ts';
import { codeOf } from './agent-fixture.ts';
import { holdRow, latch, waiterOf, waitPast } from '../support/lock-wait-race.ts';
import { serverUrl } from '../acceptance/world.ts';

/** A database is needed: without one, the file skips. */
const LIVE = it.skipIf(serverUrl === undefined);

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await aiWorld('commentgrantwait');
}, 180_000);
afterAll(async () => {
  if (serverUrl === undefined) return;
  await w?.world.drop();
});

// oxlint-disable-next-line max-lines-per-function -- the delegation, the held task, the revoke and the answer
LIVE('an agent comment cannot commit on a grant revoked while it waits for its locks', async () => {
  const task = await created(w, w.p, 'comment grant race');
  const credential = await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    const minted = await mintDelegation(tx, {
      agentActorId: w.world.agentActorId,
      delegatePersonId: w.p.personId,
      mintedByActorId: w.p.actorId,
      purpose: 'comment_race',
      collections: ['task'],
      actions: ['read', 'write', 'comment'],
      purposeScope: { kind: 'record', id: task },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!minted.ok) throw new Error(minted.refusal.code);
    return minted.value.credential;
  });
  const held = await holdRow(w.world.db, 'select id from public.records where id = $1 for update', [
    task,
  ]);
  // The revocation holds the grant row as `grant.revoke` does, so the comment,
  // which holds its grants before the task, waits on it first.
  const revoker = connect(w.world.db.appUrl);
  const locked = latch<number>();
  const released = latch();
  const revoking = revoker.withBusiness(w.world.business, async (tx) => {
    await lockAccess(tx);
    await tx.query('select id from public.grants where business_id = $1 and id = $2 for update', [
      tx.businessId,
      w.p.grants.comment,
    ]);
    const [me] = await tx.query<{ readonly pid: number }>('select pg_backend_pid() as pid');
    locked.open(Number(me?.pid));
    await released.promise;
    await revokeGrant(tx, w.p.grants.comment);
  });
  let pending: ReturnType<typeof w.world.asAgent> | undefined;
  try {
    const revokerPid = await locked.promise;
    pending = w.world.asAgent(
      {
        command: 'task.comment',
        operationId: randomUUID(),
        recordId: task,
        body: 'written after its grant was revoked',
        audience: 'internal',
      },
      credential,
    );
    await waiterOf(w.world.db, { pid: revokerPid, letGo: async () => await Promise.resolve() });
    released.open();
    await revoking;
    const [grant] = await w.world.db.admin.execute<{ revoked: boolean }>(
      'select revoked_at is not null as revoked from public.grants where id = $1',
      [w.p.grants.comment],
    );
    expect(grant?.revoked).toBe(true);
    // The revocation committed; the comment now waits on its task, and is judged after.
    await waiterOf(w.world.db, held);
  } finally {
    released.open();
    await held.letGo();
    await Promise.allSettled([revoking]);
    await revoker.close();
  }
  const answer = await pending;
  const rows = await w.world.db.admin.execute(
    "select id from public.records where data ->> 'body' = $1",
    ['written after its grant was revoked'],
  );
  expect({ code: codeOf(answer), comments: rows.length }).toEqual({
    // The agent's contract names a delegating person's lost grant DELEGATION_NARROWED (I08), as
    // the comment change does after the same wait.
    code: 'DELEGATION_NARROWED',
    comments: 0,
  });
});

LIVE('a delegation expired during a task lock wait cannot resolve live afterwards', async () => {
  const task = await created(w, w.q, 'delegation expiry race');
  const expiry = new Date(Date.now() + 2000);
  const credential = await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    const minted = await mintDelegation(tx, {
      agentActorId: w.world.agentActorId,
      delegatePersonId: w.q.personId,
      mintedByActorId: w.q.actorId,
      purpose: 'expiry_race',
      collections: ['task'],
      actions: ['read', 'write'],
      purposeScope: { kind: 'record', id: task },
      expiresAt: expiry,
    });
    if (!minted.ok) throw new Error(minted.refusal.code);
    return minted.value.credential;
  });
  const held = await holdRow(w.world.db, 'select id from public.records where id = $1 for update', [
    task,
  ]);
  const pending = w.world.db.app.withBusiness(w.world.business, async (tx) => {
    expect((await resolveDelegation(tx, w.world.agentActorId, credential)).ok).toBe(true);
    await tx.query('select id from public.records where business_id = $1 and id = $2 for update', [
      tx.businessId,
      task,
    ]);
    return await resolveDelegation(tx, w.world.agentActorId, credential);
  });
  try {
    await waiterOf(w.world.db, held);
    await waitPast(w.world.db, expiry.toISOString());
  } finally {
    await held.letGo();
  }
  expect((await pending).ok, 'the re-ask uses the time after the wait').toBe(false);
});
