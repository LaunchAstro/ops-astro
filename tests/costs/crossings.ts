// SPDX-License-Identifier: AGPL-3.0-only
//
// The cost world's crossings (`world.ts`): a second agent of alpha that picks a
// run's work up once its first holder's lease runs out, so one run has two
// agents on two leases, and a helper the holder delegates to (AW-11), whose
// calls spend on the parent's lease and reservation under its own delegation.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { grantTo } from '../commands/fixture.ts';
import { insertLogin } from '../identity/fixture.ts';
import { authorised, post, tokenFor } from '../api/fixture.ts';
import { agentPath, detailOf } from '../api/controls-fixture.ts';
import {
  mintChildDelegation,
  resolveDelegation,
} from '../../packages/core-records/src/authority/delegations.ts';
import { sweepLostWorkers } from '../../packages/core-runtime/src/index.ts';
import type { CostWorld, Started } from './world.ts';

export interface Agent {
  readonly actorId: string;
  readonly subject: string;
}

/** Another agent of alpha, signed in as itself. */
export async function anotherAgent(w: CostWorld): Promise<Agent> {
  const actorId = randomUUID();
  const subject = `cost-agent-${randomUUID()}`;
  await w.controls.fixture.db.app.withBusiness(w.alpha, async (tx) => {
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      w.alpha,
      actorId,
    ]);
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [w.alpha, randomUUID(), await insertLogin(tx, subject), actorId, w.controls.manager.actorId],
    );
  });
  return { actorId, subject };
}

/** The manager holds `run:write`, so a pickup's delegation reaches `run` and may delegate. */
export async function letPickupsDelegate(w: CostWorld): Promise<void> {
  await w.controls.fixture.db.app.withBusiness(w.alpha, async (tx) => {
    await grantTo(tx, w.controls.manager, 'write', undefined, true, 'run');
  });
}

/**
 * The replacement: `first`'s lease runs out, the sweep brings the work back,
 * and `agent` picks the same run up again on a lease and delegation of its own.
 */
export async function replace(w: CostWorld, first: Started, agent: Agent): Promise<Started> {
  const { db } = w.controls.fixture;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- polls, one look at a time
    const [row] = await db.admin.execute<{ readonly past: boolean }>(
      `select clock_timestamp() > expires_at as past from public.leases where id = $1`,
      [first.picked['leaseId']],
    );
    if (row?.past === true) break;
    // eslint-disable-next-line no-await-in-loop -- polls, one look at a time
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  await db.app.withBusiness(w.alpha, async (tx) => await sweepLostWorkers(tx));
  const [back] = await db.admin.execute<{ readonly id: string }>(
    `select id from public.reservations
      where business_id = $1 and run_id = $2 and state = 'held' and lease_id is null`,
    [w.alpha, first.runId],
  );
  const answer = await post(
    w.controls.api,
    agentPath('task.pickup'),
    { operationId: randomUUID(), reservationId: back?.id },
    authorised(await tokenFor(agent.subject)),
  );
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  const picked = detailOf(answer);
  const [lease] = await db.admin.execute<{ readonly run_id: string }>(
    `select run_id from public.leases where id = $1`,
    [picked['leaseId']],
  );
  expect(lease?.run_id).toBe(first.runId);
  return { runId: first.runId, taskId: first.taskId, picked };
}

/** A child delegation (AW-11) the holder of `parent` mints to `helper`; its id. */
export async function helperChild(w: CostWorld, parent: Started, helper: Agent): Promise<string> {
  const { db, agentActorId } = w.controls.fixture;
  return await db.app.withBusiness(w.alpha, async (tx) => {
    const held = await resolveDelegation(tx, agentActorId, String(parent.picked['credential']));
    if (!held.ok) throw new Error('costs: the parent delegation did not resolve');
    const minted = await mintChildDelegation(tx, held.value, {
      agentActorId: helper.actorId,
      purpose: 'child_fleet',
      collections: ['task'],
      actions: ['read', 'write'],
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!minted.ok) throw new Error(`costs: the child was refused: ${minted.refusal.code}`);
    return minted.value.delegation.id;
  });
}
