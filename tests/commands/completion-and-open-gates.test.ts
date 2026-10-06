// SPDX-License-Identifier: AGPL-3.0-only
//
// A task is not completed while an approval gate on it is open (contract 4.3).
// A gate is open when it is pending, before its deadline, on a live lineage's
// current version: the gates `gate.pending` lists. A pending gate left on a
// cancelled lineage, or on a version a later one superseded, waits on nobody,
// so it does not hold the task open.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
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

/** Resolves when `check` holds, polling the database's own clock and locks. */
async function waitUntil(check: () => Promise<boolean>, milliseconds = 10_000): Promise<void> {
  const until = Date.now() + milliseconds;
  // oxlint-disable-next-line no-await-in-loop
  while (!(await check())) {
    if (Date.now() >= until) throw new Error('timed out waiting for the database schedule');
    // oxlint-disable-next-line no-await-in-loop
    await delay(20);
  }
}

const nothing = (): void => {};

function latch(): { readonly promise: Promise<void>; release: () => void } {
  const made = { promise: Promise.resolve(), release: nothing };
  made.promise = new Promise<void>((resolve) => {
    made.release = resolve;
  });
  return made;
}

/** The task's row held `for update` on a connection of its own until `release`. */
async function holdTaskRow(world: World, taskId: string) {
  const blocker = connect(world.db.appUrl);
  const held = latch();
  const release = latch();
  let pid = 0;
  const holder = blocker.withBusiness(world.alpha, async (tx) => {
    const [row] = await tx.query<{ readonly pid: number }>('select pg_backend_pid() as pid');
    pid = row?.pid ?? 0;
    await tx.query('select 1 from public.records where business_id = $1 and id = $2 for update', [
      tx.businessId,
      taskId,
    ]);
    held.release();
    await release.promise;
  });
  await held.promise;
  let closed: Promise<void> | undefined;
  return {
    pid,
    release: async (): Promise<void> => {
      release.release();
      closed ??= holder.then(async () => await blocker.close());
      await closed;
    },
  };
}

/**
 * Completes the task from behind a lock on its row that is held until the
 * gate's deadline has passed: the completion's transaction starts before the
 * deadline and reaches its gate check after it.
 */
async function completeAcrossTheDeadline(world: World, taskId: string, gateId: string) {
  await world.db.admin.execute(
    `update public.gates set expires_at = clock_timestamp() + interval '1500 milliseconds'
      where business_id = $1 and id = $2`,
    [world.alpha, gateId],
  );
  const expectedRevision = await revisionOf(world, taskId);
  const row = await holdTaskRow(world, taskId);
  try {
    const completing = asAda(world, '/task/complete', {
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision,
    });
    await waitUntil(async () => {
      const [ready] = await world.db.admin.execute<{ readonly ready: boolean }>(
        `select clock_timestamp() > g.expires_at and exists (
           select 1 from pg_stat_activity where $3 = any(pg_blocking_pids(pid))) as ready
           from public.gates g where g.business_id = $1 and g.id = $2`,
        [world.alpha, gateId, row.pid],
      );
      return ready?.ready === true;
    });
    await row.release();
    return (await completing).code;
  } finally {
    await row.release();
  }
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

describe.skipIf(serverUrl === undefined)('a gate that lapses while completion waits', () => {
  let world: World | undefined;

  afterEach(async () => {
    await world?.close();
    world = undefined;
  });

  it('completes once a gate that lapsed while the completion waited for the task no longer holds it', async () => {
    world = await createWorld('opengate');
    const { taskId, on } = await proposedTask(world);
    expect(await completeAcrossTheDeadline(world, taskId, on.gateId)).toBe('ok');
  }, 60_000);
});
