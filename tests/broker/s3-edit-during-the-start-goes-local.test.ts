// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01 personal information stays local, S3: an agent's edit to the run's
// task, committed while a reserved cloud call's start waits on the task's
// lock, is read with the write that made it, so the call goes local and is
// released unsent.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { reserveModelCall, sendReservedCall } from '../../packages/core-custody/src/index.ts';
import { awaitParked, liveWork, racer } from '../runtime/schedules-harness.ts';
import {
  CLOUD,
  caller,
  noDatabase,
  requestFor,
  rowsOf,
  s,
  stepOf,
  useBrokerWorld,
  withRoutes,
  world,
} from './broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('s3start');

/** The agent's title edit and its applied register row, held uncommitted until `commit`. */
async function heldEdit(taskId: string) {
  const editor = racer(s);
  let commit!: () => void;
  const gate = new Promise<void>((resolve) => {
    commit = resolve;
  });
  let written!: () => void;
  const ready = new Promise<void>((resolve) => {
    written = resolve;
  });
  const editing = editor.withBusiness(s.business, async (tx) => {
    await tx.query(
      `update public.records set data = data || '{"title":"s3 edited during the start"}'::jsonb
        where business_id = $1 and id = $2`,
      [s.business, taskId],
    );
    await tx.query(
      `insert into public.operations
         (business_id, id, operation_id, command, actor_id, payload_digest, outcome, result, record_id, revision)
       values ($1, $2, $3, 'task.update', $4, $5, 'applied', '{}'::jsonb, $6, 2)`,
      [s.business, randomUUID(), `s3-${randomUUID()}`, s.agentActorId, '0'.repeat(64), taskId],
    );
    written();
    await gate;
  });
  await ready;
  const end = async () => {
    commit();
    await editing.catch(() => {});
    await editor.close();
  };
  return { commit, editing, end };
}

it("AW-01 personal information stays local (S3) race: an agent's edit committed while the start waits on the task releases the call unsent", async () => {
  const work = await liveWork(s, 's3 an edit during the start', 2_000);
  await stepOf(work);
  world.provider.mode('answer');
  const request = requestFor(work, {
    fields: [{ name: 'tone', from: { recordId: work.taskId, key: 'title' } }],
  });
  const cloud = withRoutes([CLOUD]);
  const reserving = await s.db.app.withBusiness(
    s.business,
    async (tx) => await reserveModelCall(tx, caller(work), request, cloud),
  );
  if (!reserving.ok) throw new Error(`the hold was refused ${reserving.code}`);
  expect(reserving.reserved.route.reach).toBe('cloud');
  const seen = world.provider.seen.length;
  const edit = await heldEdit(work.taskId);
  try {
    const starting = sendReservedCall(
      s.db.app,
      s.business,
      caller(work),
      request,
      reserving.reserved,
      cloud,
    );
    // Parked on the task row, then the edit and its operation commit.
    await awaitParked(s, 'records', 1);
    edit.commit();
    await edit.editing;
    expect(await starting).toEqual({
      ok: false,
      code: 'LOCAL_MODEL_REQUIRED',
      callId: reserving.reserved.callId,
    });
    expect(world.provider.seen.length).toBe(seen);
    expect(await rowsOf(reserving.reserved.callId)).toMatchObject([
      { state: 'released', started_at: null },
    ]);
  } finally {
    await edit.end();
  }
}, 120_000);
