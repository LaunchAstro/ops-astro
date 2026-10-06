// SPDX-License-Identifier: AGPL-3.0-only
//
// SR-1: the click-through seed's stop at the cap takes its locks in the
// product's order (`core-runtime/src/locks.ts`): the task before the run, as
// cancellation takes them, so the two cannot wait on each other in a cycle.
//
// The order is proved directly rather than by racing a cancellation: another
// connection holds the run's row, the stop is started and seen waiting on a
// lock, and a third connection then asks for the task's row without waiting.
// It is refused only if the stop already holds the task while it waits for
// the run. The run then stops at its ceiling once the run is let go.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { readEnvFile } from '../../packages/core-records/src/env-file.ts';
import {
  connectAsAdmin,
  type BusinessId,
} from '../../packages/core-records/src/tenancy/database.ts';
import { stopAtCeiling } from '../../scripts/ops/click-through-stop.ts';
import {
  adminUrlOf,
  closeWorld,
  openCast,
  person,
  serverUrl,
  type Cast,
} from './click-through-seed.fixture.ts';

let cast: Cast;

type Detail = Readonly<Record<string, unknown>>;

async function as(body: Detail, agent = false, credential?: string): Promise<Detail> {
  const request = { operationId: `made-up:${randomUUID()}`, ...body } as never;
  const business = cast.business as BusinessId;
  const result = agent
    ? await executeAgentCommand(cast.db.app, business, agentOf(), credential, request)
    : await executeCommand(cast.db.app, business, person(cast, 'ada@alpha.local'), 'api', request);
  if (isCommandRefusal(result)) throw new Error(`${String(body['command'])} ${result.code}`);
  return { ...result.detail, recordId: result.recordId, revision: result.revision };
}

function agentOf() {
  const file = join(cast.root, '.local/synthetic-agents.json');
  const agents = JSON.parse(readFileSync(file, 'utf8')) as { business: string; subject: string }[];
  const subject = agents.find((agent) => agent.business === 'alpha')?.subject ?? '';
  return { provider: 'supabase', subject } as const;
}

/** A task proposed, approved and picked up by the agent, with a small ceiling. */
async function pickedUp(): Promise<{ taskId: string; leaseId: string; runId: string }> {
  const task = await as({ command: 'task.create', fields: { title: 'Made-up capped work' } });
  const proposal = await as({
    command: 'task.propose',
    recordId: task['recordId'],
    expectedRevision: task['revision'],
    purpose: 'made_up_cap_order',
    maximumMinor: 400,
    currency: 'AUD',
    payload: { instruction: 'made up' },
    step: { kind: 'compose', payload: {} },
  });
  const decided = await as({
    command: 'task.decide',
    gateId: proposal['gateId'],
    versionId: proposal['versionId'],
    decision: 'approve',
    note: 'made up',
  });
  const picked = await as(
    { command: 'task.pickup', reservationId: decided['reservationId'] },
    true,
  );
  const [run] = await cast.db.admin.execute<{ run_id: string }>(
    'select run_id from public.leases where id = $1',
    [picked['leaseId']],
  );
  return {
    taskId: String(task['recordId']),
    leaseId: String(picked['leaseId']),
    runId: run!.run_id,
  };
}

describe.skipIf(serverUrl === undefined)('SR-1 click-through seed cap-stop lock order', () => {
  beforeAll(async () => {
    cast = await openCast('sr1clicklock');
    const gate = readEnvFile(join(cast.local, 'gate.env'));
    process.env['GATE_SIGNING_KEY_ID'] = gate['GATE_SIGNING_KEY_ID'] ?? '';
    process.env['GATE_SIGNING_SECRET'] = gate['GATE_SIGNING_SECRET'] ?? '';
    process.env['DELEGATION_CREDENTIAL_KEY_FILE'] = join(cast.local, 'delegation.env');
  }, 300_000);

  afterAll(async () => {
    await closeWorld(cast);
  });

  it('holds the task before it waits for the run, then stops the run at its ceiling', async () => {
    const work = await pickedUp();
    const holder = connectAsAdmin(adminUrlOf(cast.db), { source: 'admin' });
    const probe = connectAsAdmin(adminUrlOf(cast.db), { source: 'admin' });
    let stopping: Promise<void> | undefined;
    try {
      await holder.transaction(async (execute) => {
        await execute('select 1 from public.planned_runs where id = $1 for update', [work.runId]);
        stopping = stopAtCeiling(cast.db.app, cast.business, work.leaseId);
        await waitForLockWait(probe);
        const taken = probe.transaction(async (probeExecute) => {
          await probeExecute('select 1 from public.records where id = $1 for update nowait', [
            work.taskId,
          ]);
        });
        await expect(taken).rejects.toMatchObject({ code: '55P03' });
      });
      await stopping;
    } finally {
      await stopping?.catch(() => {});
      await Promise.all([holder.close(), probe.close()]);
    }
    const [run] = await cast.db.admin.execute<{ state: string }>(
      'select state from public.planned_runs where id = $1',
      [work.runId],
    );
    expect(run?.state).toBe('waiting_budget');
  }, 120_000);
});

/** Until a backend of this database waits on a lock, or ten seconds. */
async function waitForLockWait(probe: ReturnType<typeof connectAsAdmin>): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    // Polled in turn: each look is after the one before.
    // oxlint-disable-next-line no-await-in-loop
    const [row] = await probe.execute<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if ((row?.n ?? 0) > 0) return;
    // oxlint-disable-next-line no-await-in-loop
    await pause(50);
  }
  throw new Error('the stop was never seen waiting on a lock');
}
