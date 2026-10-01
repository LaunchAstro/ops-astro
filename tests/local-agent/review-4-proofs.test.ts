// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859), Opus review 4's proofs (R/local-agent/REVIEW-4.md), for range
// bed7eecb3..de41d3d85. Apply unchanged as tests/local-agent/review-4-proofs.test.ts.
// Both proofs need a database and skip without one. No assertion prints a key.
// Made-up data only.
//
// The state they set up is the one docs/local/LOCAL-AGENT.md names: a tick
// died holding approvals.json.lock, so the lock is left in the runner's home,
// and the owner has said yes to an approval the tick raised.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import type { ModelCallExecutor } from '../../packages/core-commands/src/index.ts';
import { APPROVAL_PURPOSE, needOf, raiseApproval } from '../../apps/local-agent/approval.ts';
import { runQueuedTasks, type TaskTick } from '../../apps/local-agent/tick.ts';
import { localGate } from '../../apps/local-agent/tick-main.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  approve,
  asPerson,
  codeOf,
  createTask,
  freshPurpose,
  liveWork,
  openSchedules,
  propose,
  rows,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import { makeWorld, type World } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();
const LOCAL = { OPS_ENVIRONMENT: 'local' } as const;
const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

/** The broker's answer for a step that ran: answered, with words. */
const answered: ModelCallExecutor = async () =>
  await Promise.resolve({
    command: 'model.call',
    recordId: null,
    revision: null,
    detail: { callId: randomUUID(), state: 'answered', text: 'made-up reply' },
  } as Awaited<ReturnType<ModelCallExecutor>>);

const taskTick = (s: Schedules, home: string): TaskTick => ({
  environment: LOCAL,
  database: s.db.app,
  businessId: s.business,
  agent: s.agent,
  executeModelCall: answered,
  operation: 'model.local_claude_compose',
  fieldsFor: () => [],
  gate: localGate(
    { environment: LOCAL, database: s.db.app, businessId: s.business, agent: s.agent, home },
    { home, capUsd: 10, capConfigured: false },
  ),
});

/** The tick asked for sonnet, and the owner said yes: the approval is queued work. */
async function approvedAsk(s: Schedules, home: string): Promise<void> {
  const work = await liveWork(s, `Local model ask ${randomUUID().slice(0, 8)}`, 2_000);
  const raised = await raiseApproval(
    { environment: LOCAL, database: s.db.app, businessId: s.business, agent: s.agent, home },
    {
      leaseId: String(work.picked['leaseId']),
      fence: Number(work.picked['fence']),
      credential: String(work.picked['credential']),
    },
    needOf('LOCAL_MODEL_NOT_APPROVED', 'sonnet'),
  );
  expect(raised).toEqual({ ok: true, raised: true });
  const [gate] = await rows<{ gate_id: string; version_id: string }>(
    s,
    `select g.id as gate_id, v.id as version_id
       from public.gates g
       join public.proposal_versions v on v.business_id = g.business_id and v.id = g.version_id
      where g.business_id = $1 and g.state = 'pending' and v.purpose = $2`,
    [s.business, APPROVAL_PURPOSE],
  );
  if (gate === undefined) throw new Error('no pending approval gate');
  const decided = await asPerson(s, {
    command: 'task.decide',
    operationId: randomUUID(),
    gateId: gate.gate_id,
    versionId: gate.version_id,
    decision: 'approve',
    note: "the owner's yes on another model",
  });
  expect(codeOf(decided)).toBe('applied');
}

/** Ordinary approved work in the queue. */
async function queued(s: Schedules): Promise<string> {
  const taskId = await createTask(s, `Local work ${randomUUID().slice(0, 8)}`);
  const proposal = await propose(s, taskId, { maximumMinor: 2_000, purpose: freshPurpose() });
  await approve(s, proposal);
  return taskId;
}

/** Live leases on the approval gate's own work. */
const liveApprovalLeases = async (s: Schedules): Promise<number> => {
  const [row] = await rows<{ n: string }>(
    s,
    `select count(*)::text as n
       from public.leases l
       join public.reservations res on res.business_id = l.business_id and res.lease_id = l.id
       join public.proposal_versions v on v.business_id = res.business_id and v.id = res.version_id
      where l.business_id = $1 and l.state = 'live' and v.purpose = $2`,
    [s.business, APPROVAL_PURPOSE],
  );
  return Number(row?.n ?? 0);
};

async function withLockedHome(
  part: string,
  body: (s: Schedules, world: World) => Promise<void>,
): Promise<void> {
  const s = await openSchedules(part, 1_000_000);
  const world = makeWorld();
  try {
    // What a tick that died holding the lock leaves behind.
    world.write('approvals.json.lock', '4242');
    await approvedAsk(s, world.agentHome);
    await body(s, world);
  } finally {
    world.remove();
    await s.db.drop();
  }
}

it('Sol proof, criterion 8: a lock left on approvals.json does not stop the pass running the other queued work', async () => {
  await withLockedHome('la1r4pass', async (s, world) => {
    const taskId = await queued(s);
    await expect(runQueuedTasks(taskTick(s, world.agentHome))).resolves.toMatchObject({
      ok: true,
      ran: [{ taskId, outcome: 'completed' }],
    });
  });
}, 180_000);

it('Sol proof, criterion 8: an approval the lock stopped is not left picked up under its lease', async () => {
  await withLockedHome('la1r4lease', async (s, world) => {
    await runQueuedTasks(taskTick(s, world.agentHome)).catch(() => undefined);
    expect(await liveApprovalLeases(s)).toBe(0);
  });
}, 180_000);
