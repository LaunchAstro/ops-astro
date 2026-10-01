// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859) addendum 2, item 3: the local agent's approval gate is the
// product's own. A refused call (the cap, or a model other than Haiku) is
// handed back with a successor proposal of purpose `local_agent_approval`,
// which raises the ordinary decision gate and its inbox item for the owner,
// once while it is open. The owner's yes is approved work the agent picks up
// to write `approvals.json`; a no writes nothing. Local only. Made-up data.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import {
  APPROVAL_PURPOSE,
  applyApprovals,
  needOf,
  raiseApproval,
  type ApprovalOptions,
  type HeldLease,
} from '../../apps/local-agent/approval.ts';
import { createRunner } from '../../apps/local-agent/runner.ts';
import { readSettings } from '../../apps/local-agent/settings.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  asPerson,
  codeOf,
  liveWork,
  openSchedules,
  rows,
  seedSchedules,
  type Schedules,
  type Work,
} from '../runtime/schedules-harness.ts';
import { makeWorld, RUNNER_KEY, type World } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();
const LOCAL = { OPS_ENVIRONMENT: 'local' } as const;

interface PendingGate {
  readonly gate_id: string;
  readonly version_id: string;
  readonly payload: Record<string, unknown>;
}

let s: Schedules;
let other: Schedules;
let world: World;

const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

const options = (environment: Record<string, string | undefined> = LOCAL): ApprovalOptions => ({
  environment,
  database: s.db.app,
  businessId: s.business,
  agent: s.agent,
  home: world.agentHome,
});

function leaseOf(work: Work): HeldLease {
  return {
    leaseId: String(work.picked['leaseId']),
    fence: Number(work.picked['fence']),
    credential: String(work.picked['credential']),
  };
}

const pending = async (world_: Schedules = s): Promise<readonly PendingGate[]> =>
  await rows<PendingGate>(
    world_,
    `select g.id as gate_id, v.id as version_id, v.payload
       from public.gates g
       join public.proposal_versions v on v.business_id = g.business_id and v.id = g.version_id
      where g.business_id = $1 and g.state = 'pending' and v.purpose = $2
      order by g.created_at`,
    [world_.business, APPROVAL_PURPOSE],
  );

const openItemsFor = async (world_: Schedules, personId: string): Promise<number> => {
  const [row] = await rows<{ n: string }>(
    world_,
    `select count(*)::text as n from public.inbox_items i
       join public.gates g on g.business_id = i.business_id and g.id = i.fact_id
       join public.proposal_versions v on v.business_id = g.business_id and v.id = g.version_id
      where i.recipient_person_id = $1 and i.reason = 'decision' and i.work_state = 'open'
        and v.purpose = $2`,
    [personId, APPROVAL_PURPOSE],
  );
  return Number(row?.n ?? 0);
};

const decide = async (as: Schedules, gate: PendingGate, decision: 'approve' | 'reject') =>
  await asPerson(as, {
    command: 'task.decide',
    operationId: randomUUID(),
    gateId: gate.gate_id,
    versionId: gate.version_id,
    decision,
    note: `the owner's ${decision} on the local agent`,
  });

const approvals = (): Record<string, unknown> | undefined => {
  const file = join(world.agentHome, 'approvals.json');
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)
    : undefined;
};

beforeAll(async () => {
  s = await openSchedules('la1appr', 1_000_000);
  other = await seedSchedules(s.db, 'la1approther', 1_000_000);
  world = makeWorld();
}, 180_000);

afterAll(async () => {
  world?.remove();
  await s?.db.drop();
});

it('a refused cap raises one decision item for the owner, naming USD 30, and no second while open', async () => {
  const first = await liveWork(s, `Local cap ${randomUUID().slice(0, 8)}`, 2_000);
  const raised = await raiseApproval(
    options(),
    leaseOf(first),
    needOf('LOCAL_CAP_REACHED', 'haiku'),
  );
  expect(raised).toEqual({ ok: true, raised: true });
  const gates = await pending();
  expect(gates).toHaveLength(1);
  expect(gates[0]?.payload).toMatchObject({ localAgentApproval: { kind: 'cap', capUsd: 30 } });
  expect(await openItemsFor(s, s.decider.personId)).toBe(1);

  const second = await liveWork(s, `Local cap again ${randomUUID().slice(0, 8)}`, 2_000);
  const again = await raiseApproval(
    options(),
    leaseOf(second),
    needOf('LOCAL_CAP_REACHED', 'haiku'),
  );
  expect(again).toEqual({ ok: true, raised: false });
  expect(await pending()).toHaveLength(1);
  expect(await openItemsFor(s, s.decider.personId)).toBe(1);
}, 120_000);

it('a model other than Haiku raises its own item, naming the model', async () => {
  const work = await liveWork(s, `Local model ${randomUUID().slice(0, 8)}`, 2_000);
  const raised = await raiseApproval(
    options(),
    leaseOf(work),
    needOf('LOCAL_MODEL_NOT_APPROVED', 'sonnet'),
  );
  expect(raised).toEqual({ ok: true, raised: true });
  const gates = await pending();
  expect(gates.map((gate) => gate.payload['localAgentApproval'])).toEqual([
    { kind: 'cap', capUsd: 30 },
    { kind: 'model', model: 'sonnet' },
  ]);
  expect(await openItemsFor(s, s.decider.personId)).toBe(2);
}, 120_000);

it('another business never sees or decides the item', async () => {
  expect(await openItemsFor(other, other.decider.personId)).toBe(0);
  const [gate] = await pending();
  if (gate === undefined) throw new Error('no pending gate');
  const crossed = await decide(other, gate, 'approve');
  expect(codeOf(crossed)).not.toBe('applied');
  expect(await pending()).toHaveLength(2);
}, 120_000);

it("the owner's no leaves the model refused and writes nothing", async () => {
  const model = (await pending()).find(
    (gate) => (gate.payload['localAgentApproval'] as { kind?: string }).kind === 'model',
  );
  if (model === undefined) throw new Error('no model gate');
  expect(codeOf(await decide(s, model, 'reject'))).toBe('applied');
  const applied = await applyApprovals(options());
  expect(applied).toEqual({ ok: true, applied: [] });
  expect(approvals()).toBeUndefined();
}, 120_000);

it("the owner's yes writes approvals.json and the next call runs past the old cap", async () => {
  const cap = (await pending()).find(
    (gate) => (gate.payload['localAgentApproval'] as { kind?: string }).kind === 'cap',
  );
  if (cap === undefined) throw new Error('no cap gate');
  expect(codeOf(await decide(s, cap, 'approve'))).toBe('applied');
  const applied = await applyApprovals(options());
  expect(applied).toEqual({ ok: true, applied: [{ kind: 'cap', capUsd: 30 }] });
  expect(approvals()).toEqual({ capUsd: 30, models: [] });
  // Applied once: the approval's own work is handed back, so a second pass finds nothing.
  expect(await applyApprovals(options())).toEqual({ ok: true, applied: [] });

  world.write('ledger.jsonl', `${JSON.stringify({ costUsd: 10 })}\n`);
  const read = readSettings(world.env, world.userHome);
  if (!read.ok) throw new Error(read.code);
  const runner = await createRunner(read.settings, () => {});
  try {
    const response = await fetch(`${runner.origin}/v1/local-claude/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${RUNNER_KEY}` },
      body: JSON.stringify({ fields: { message: 'Say hello.' } }),
    });
    const reply = (await response.json()) as Record<string, unknown>;
    expect(reply['code']).toBeNull();
    expect(world.calls('hey')).toHaveLength(1);
  } finally {
    await runner.close();
  }
}, 120_000);

it.each([
  ['staging', { OPS_ENVIRONMENT: 'staging' }],
  ['production', { OPS_ENVIRONMENT: 'production' }],
  ['unset', {}],
])(
  'refused outside OPS_ENVIRONMENT=local (%s): no item, no file',
  async (_, environment) => {
    const before = (await pending()).length;
    const work = await liveWork(s, `Local fenced ${randomUUID().slice(0, 8)}`, 2_000);
    const raised = await raiseApproval(
      options(environment),
      leaseOf(work),
      needOf('LOCAL_MODEL_NOT_APPROVED', 'opus'),
    );
    expect(raised).toMatchObject({ ok: false, code: 'LOCAL_ONLY' });
    expect(await applyApprovals(options(environment))).toMatchObject({
      ok: false,
      code: 'LOCAL_ONLY',
    });
    expect(await pending()).toHaveLength(before);
  },
  120_000,
);
