// SPDX-License-Identifier: AGPL-3.0-only
//
// A task is not completed while an approval gate on it is open (contract 4.3).
// A gate is open when it is pending, before its deadline, on a live lineage's
// current version: the gates `gate.pending` lists. A pending gate left on a
// cancelled lineage, or on a version a later one superseded, waits on nobody,
// so it does not hold the task open.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bearer,
  call,
  createWorld,
  personPath,
  serverUrl,
  type World,
} from '../acceptance/world.ts';

interface Proposed {
  readonly gateId: string;
  readonly versionId: string;
  readonly lineageId: string;
}

const asAda = async (world: World, name: string, body: Readonly<Record<string, unknown>>) =>
  await call(world.api, personPath('alpha', name), body, bearer(world.ada.token));

async function revisionOf(world: World, recordId: string): Promise<number> {
  const rows = await world.db.admin.execute<{ readonly revision: string }>(
    'select revision::text as revision from public.records where business_id = $1 and id = $2',
    [world.alpha, recordId],
  );
  return Number(rows[0]?.revision ?? '0');
}

async function proposedTask(world: World): Promise<{ taskId: string; on: Proposed }> {
  const created = await asAda(world, '/task/create', {
    operationId: randomUUID(),
    fields: { title: `completed past a gate ${randomUUID()}` },
  });
  expect(created.code, 'create').toBe('ok');
  const taskId = String(created.body['recordId']);
  const proposed = await asAda(world, '/task/propose', {
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: await revisionOf(world, taskId),
    purpose: 'draft_the_reply',
    maximumMinor: 1500,
    currency: 'AUD',
    payload: { instruction: 'draft a reply' },
    step: { kind: 'compose', payload: {} },
  });
  expect(proposed.code, 'propose').toBe('ok');
  const detail = proposed.body['detail'] as Record<string, string>;
  return {
    taskId,
    on: {
      gateId: String(detail['gateId']),
      versionId: String(detail['versionId']),
      lineageId: String(detail['lineageId']),
    },
  };
}

async function complete(world: World, taskId: string): Promise<string> {
  const answer = await asAda(world, '/task/complete', {
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: await revisionOf(world, taskId),
  });
  return answer.code;
}

async function gateState(world: World, gateId: string): Promise<string | undefined> {
  const rows = await world.db.admin.execute<{ readonly state: string }>(
    'select state from public.gates where business_id = $1 and id = $2',
    [world.alpha, gateId],
  );
  return rows[0]?.state;
}

if (serverUrl === undefined) {
  console.warn('commands/completion-and-open-gates: DATABASE_URL is unset, so nothing ran.');
}

describe.skipIf(serverUrl === undefined)('completing a task waits only on an open gate', () => {
  let world: World | undefined;

  afterEach(async () => {
    await world?.close();
    world = undefined;
  });

  it('refuses GATE_PENDING while a live lineage has a pending gate', async () => {
    world = await createWorld('opengate');
    const { taskId } = await proposedTask(world);
    expect(await complete(world, taskId)).toBe('GATE_PENDING');
  }, 60_000);

  it('completes a task whose pending gate sits on a cancelled lineage', async () => {
    world = await createWorld('opengate');
    const { taskId, on } = await proposedTask(world);
    const cancelled = await asAda(world, '/task/cancel', {
      operationId: randomUUID(),
      recordId: taskId,
      lineageId: on.lineageId,
      reason: 'no longer needed',
    });
    expect(cancelled.code, 'cancel').toBe('ok');
    expect(await gateState(world, on.gateId), 'the gate is left pending').toBe('pending');
    expect(await complete(world, taskId)).toBe('ok');
  }, 60_000);

  it("completes a task whose pending gate's version is superseded", async () => {
    world = await createWorld('opengate');
    const { taskId, on } = await proposedTask(world);
    // Superseding through `task.propose` also closes the gate, so the owner
    // marks the version superseded with its triggers off for the one statement.
    await world.db.admin.execute('alter table public.proposal_versions disable trigger all');
    try {
      await world.db.admin.execute(
        `update public.proposal_versions set superseded_at = now()
          where business_id = $1 and id = $2`,
        [world.alpha, on.versionId],
      );
    } finally {
      await world.db.admin.execute('alter table public.proposal_versions enable trigger all');
    }
    expect(await gateState(world, on.gateId), 'the gate is left pending').toBe('pending');
    expect(await complete(world, taskId)).toBe('ok');
  }, 60_000);
});
