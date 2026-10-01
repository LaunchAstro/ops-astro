// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-1, the world the checks and run-control tests share: a fresh business
// through the real boundary, a person holding write without decide, and a run
// the agent has picked up under a live lease.

import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { createControls, type Controls } from './controls-fixture.ts';

export interface ChecksWorld {
  readonly c: Controls;
  /** Holds read and write on the business, never decide. */
  readonly writer: Member;
}

export async function checksWorld(name: string): Promise<ChecksWorld> {
  const c = await createControls(name);
  const writer = await enrol(c.fixture.db.app, c.fixture.business, 'writer');
  await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
    await grantTo(tx, writer, 'read');
    await grantTo(tx, writer, 'write');
  });
  return { c, writer };
}

export interface PickedUp {
  readonly taskId: string;
  readonly lineageId: string;
  readonly versionId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly credential: string;
}

/** A task whose approved run the agent has picked up, with the lease it works under. */
export async function pickedUpOn(c: Controls, purpose: string): Promise<PickedUp> {
  const task = await c.createTask(`a task for ${purpose}`);
  const proposal = await c.propose(task.id, task.revision, purpose);
  const reservationId = await c.approve(proposal);
  const picked = await c.pickup(reservationId, 600);
  return {
    taskId: task.id,
    lineageId: String(proposal['lineageId']),
    versionId: String(proposal['versionId']),
    leaseId: String(picked['leaseId']),
    fence: Number(picked['fence']),
    credential: String(picked['credential']),
  };
}

export const CHECK_ROWS = `select count(*)::text as n from public.run_checks where task_id = $1`;
