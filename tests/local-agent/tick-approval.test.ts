// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859) addendum 2, item 3, in the tick: a model step the runner
// refused comes back released, and the broker does not say why. The tick
// process's gate asks the runner's own gate again (gate.ts, the same ledger
// and approvals.json): at the cap, or on a model the owner has not approved,
// the work is handed back with one decision item for the owner; any other
// release raises nothing. Approved approvals are applied before the task
// pass, so their work never reaches the model and the next call already runs
// under them. Local only. Made-up data.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import type { ModelCallExecutor } from '../../packages/core-commands/src/index.ts';
import { APPROVAL_PURPOSE } from '../../apps/local-agent/approval.ts';
import { runQueuedTasks, type TaskTick, type TickGate } from '../../apps/local-agent/tick.ts';
import { localGate } from '../../apps/local-agent/tick-main.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  approve,
  asPerson,
  codeOf,
  createTask,
  freshPurpose,
  openSchedules,
  propose,
  rows,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import { makeWorld, type World } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();
const LOCAL = { OPS_ENVIRONMENT: 'local' } as const;
const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

let s: Schedules;
let world: World;
let calls = 0;

/** The broker's answer when the runner refused: released, with no reason the tick can read. */
const released: ModelCallExecutor = async () => {
  calls += 1;
  return await Promise.resolve({
    command: 'model.call',
    recordId: null,
    revision: null,
    detail: { callId: randomUUID(), state: 'released', outcome: 'CALL_RELEASED' },
  } as Awaited<ReturnType<ModelCallExecutor>>);
};

const gateFor = (home: string): TickGate =>
  localGate(
    { environment: LOCAL, database: s.db.app, businessId: s.business, agent: s.agent, home },
    { home, capUsd: 10 },
  );

const taskTick = (gate: TickGate): TaskTick => ({
  environment: LOCAL,
  database: s.db.app,
  businessId: s.business,
  agent: s.agent,
  executeModelCall: released,
  operation: 'model.local_claude_compose',
  fieldsFor: () => [],
  gate,
});

const queued = async (): Promise<string> => {
  const taskId = await createTask(s, `Local gate ${randomUUID().slice(0, 8)}`);
  const proposal = await propose(s, taskId, { maximumMinor: 2_000, purpose: freshPurpose() });
  await approve(s, proposal);
  return taskId;
};

interface PendingGate {
  readonly gate_id: string;
  readonly version_id: string;
  readonly payload: Record<string, unknown>;
}

const pending = async (): Promise<readonly PendingGate[]> =>
  await rows<PendingGate>(
    s,
    `select g.id as gate_id, v.id as version_id, v.payload
       from public.gates g
       join public.proposal_versions v on v.business_id = g.business_id and v.id = g.version_id
      where g.business_id = $1 and g.state = 'pending' and v.purpose = $2`,
    [s.business, APPROVAL_PURPOSE],
  );

const openItems = async (): Promise<number> => {
  const [row] = await rows<{ n: string }>(
    s,
    `select count(*)::text as n from public.inbox_items i
       join public.gates g on g.business_id = i.business_id and g.id = i.fact_id
       join public.proposal_versions v on v.business_id = g.business_id and v.id = g.version_id
      where i.recipient_person_id = $1 and i.reason = 'decision' and i.work_state = 'open'
        and v.purpose = $2`,
    [s.decider.personId, APPROVAL_PURPOSE],
  );
  return Number(row?.n ?? 0);
};

beforeAll(async () => {
  s = await openSchedules('la1tickgate', 1_000_000);
  world = makeWorld();
}, 180_000);

afterAll(async () => {
  world?.remove();
  await s?.db.drop();
});

it('a release the local gate does not explain raises nothing', async () => {
  const untouched = makeWorld();
  try {
    const taskId = await queued();
    const pass = await runQueuedTasks(taskTick(gateFor(untouched.agentHome)));
    expect(pass).toMatchObject({ ok: true, ran: [{ taskId, outcome: 'completed' }] });
    expect(await pending()).toHaveLength(0);
    expect(await openItems()).toBe(0);
  } finally {
    untouched.remove();
  }
}, 120_000);

it('a call released at the cap raises one inbox approval item', async () => {
  world.write('ledger.jsonl', `${JSON.stringify({ costUsd: 10 })}\n`);
  const first = await queued();
  const second = await queued();
  const pass = await runQueuedTasks(taskTick(gateFor(world.agentHome)));
  expect(pass).toMatchObject({
    ok: true,
    ran: [
      { taskId: first, outcome: 'refused', refusal: { code: 'LOCAL_CAP_REACHED' } },
      { taskId: second, outcome: 'refused', refusal: { code: 'LOCAL_CAP_REACHED' } },
    ],
  });
  const gates = await pending();
  expect(gates.map((gate) => gate.payload['localAgentApproval'])).toEqual([
    { kind: 'cap', capUsd: 30 },
  ]);
  expect(await openItems()).toBe(1);
}, 120_000);

it('approvals are applied before the task pass', async () => {
  const [gate] = await pending();
  if (gate === undefined) throw new Error('no pending gate');
  const decided = await asPerson(s, {
    command: 'task.decide',
    operationId: randomUUID(),
    gateId: gate.gate_id,
    versionId: gate.version_id,
    decision: 'approve',
    note: "the owner's yes on the local agent's cap",
  });
  expect(codeOf(decided)).toBe('applied');
  const taskId = await queued();
  const before = calls;
  const pass = await runQueuedTasks(taskTick(gateFor(world.agentHome)));
  // The approval's own work never reached the model; the other work ran under the new cap,
  // so its release is not the gate's and raises nothing.
  expect(pass).toMatchObject({ ok: true, ran: [{ taskId, outcome: 'completed' }] });
  expect(calls).toBe(before + 1);
  const file = join(world.agentHome, 'approvals.json');
  expect(existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : null).toEqual({
    capUsd: 30,
    models: [],
  });
  expect(await pending()).toHaveLength(0);
}, 120_000);
