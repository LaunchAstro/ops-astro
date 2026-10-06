// SPDX-License-Identifier: AGPL-3.0-only
//
// The world c80-runner-register.test.ts runs in: one business with C80's
// people, an approver, a task picked up under a live lease, and the reads of
// the register and Receipt L the cases assert on. `w` and `lease` are live
// bindings, set by useRegisterWorld's beforeAll.

import { afterAll, beforeAll, expect } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c80World, type C80World } from './c80-world.ts';
import {
  runLivePublish,
  runLiveRevert,
  type RunnerPorts,
} from '../../packages/core-commands/src/index.ts';

export const serverUrl: string | undefined = databaseUrlFromEnvironment();

export let w: C80World;
export let lease: { leaseId: string; fence: number; taskId: string; holder: string };

export function useRegisterWorld(): void {
  if (serverUrl === undefined)
    console.warn('C80 runner register: DATABASE_URL is unset, so nothing ran.');
  beforeAll(async () => {
    if (serverUrl === undefined) return;
    w = await c80World('c80reg');
    await w.setApprover(w.ben.personId);
    const picked = await w.pickUpUnder(w.cal, 'publish the About correction', w.partyA);
    const rows = await w.world.db.admin.execute<{
      readonly id: string;
      readonly fence: string;
      readonly holder: string;
    }>(
      `select id, fence::text as fence, holder_actor_id as holder
         from public.leases where task_id = $1 and state = 'live'`,
      [picked.taskId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('no live lease after pickup');
    lease = {
      leaseId: row.id,
      fence: Number(row.fence),
      taskId: picked.taskId,
      holder: row.holder,
    };
  }, 120_000);
  afterAll(async () => {
    if (serverUrl !== undefined) await w.world.drop();
  });
}

export async function approved(): Promise<string> {
  const detail = detailOf(await w.request(w.ava, { taskId: lease.taskId }));
  const id = String(detail['correctionId']);
  expect(codeOf(await w.approve(w.ben, id, String(detail['versionId'])))).toBe('not-a-refusal');
  return id;
}

type At = Parameters<typeof runLivePublish>[1];
type Answer = ReturnType<typeof runLivePublish>;

export const at = (correctionId: string, business: At['business'] = w.world.business): At => ({
  business,
  correctionId,
  leaseId: lease.leaseId,
  fence: lease.fence,
  actorId: lease.holder,
});
export const publish = async (id: string, ports: RunnerPorts): Answer =>
  await runLivePublish(w.world.db.app, at(id), ports);
export const revert = async (id: string, ports: RunnerPorts): ReturnType<typeof runLiveRevert> =>
  await runLiveRevert(w.world.db.app, at(id), ports);

export interface Entry {
  readonly operation_id: string;
  readonly command: string;
  readonly actor_id: string;
  readonly outcome: string;
  readonly detail: Record<string, string>;
}

/** The register's effect entries for one correction (not its request or decision). */
export async function entries(id: string): Promise<readonly Entry[]> {
  return await w.world.db.admin.execute<Entry>(
    `select operation_id, command, actor_id, outcome, result -> 'detail' as detail
       from public.operations where record_id = $1 and command like 'site.%'
      order by created_at, id`,
    [id],
  );
}

export async function receipt(
  id: string,
  step: string,
): Promise<Record<string, { observed: string }>> {
  const rows = await w.world.db.admin.execute<{ readonly o: Record<string, { observed: string }> }>(
    `select observations as o from public.live_correction_receipts
      where correction_id = $1 and step = $2 order by created_at desc, id desc limit 1`,
    [id, step],
  );
  return rows[0]?.o ?? {};
}

export async function expireLease(): Promise<void> {
  await w.world.db.admin.execute(
    `update public.leases set expires_at = now() - interval '1 second' where id = $1`,
    [lease.leaseId],
  );
}
export async function renewLease(): Promise<void> {
  await w.world.db.admin.execute(
    `update public.leases set expires_at = now() + interval '1 hour' where id = $1`,
    [lease.leaseId],
  );
}

/** A second lease on the task, as another runner holds it once the first expired. */
export async function takeOver(): Promise<{ leaseId: string; fence: number }> {
  await w.world.db.admin.execute(
    `update public.leases set state = 'expired', released_at = now() where id = $1`,
    [lease.leaseId],
  );
  const [row] = await w.world.db.admin.execute<{ readonly id: string; readonly fence: string }>(
    `insert into public.leases (business_id, id, task_id, run_id, reservation_id, delegation_id,
        holder_actor_id, authorised_by_person_id, fence, state, expires_at)
     select business_id, gen_random_uuid(), task_id, run_id, reservation_id, delegation_id,
        holder_actor_id, authorised_by_person_id, fence + 1, 'live', now() + interval '1 hour'
       from public.leases where id = $1
     returning id, fence::text as fence`,
    [lease.leaseId],
  );
  if (row === undefined) throw new Error('no second lease');
  return { leaseId: row.id, fence: Number(row.fence) };
}

/** The first lease live again, the second ended. */
export async function handBack(second: string): Promise<void> {
  await w.world.db.admin.execute(
    `update public.leases set state = 'released', released_at = now() where id = $1`,
    [second],
  );
  await w.world.db.admin.execute(
    `update public.leases set state = 'live', released_at = null,
        expires_at = now() + interval '1 hour' where id = $1`,
    [lease.leaseId],
  );
}
