// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859) review 2, M3 and M4: what the tick writes into approvals.json
// is only what its own agent asked for, in the words the decider read, and
// it is written through a fresh private file. An approval of purpose
// `local_agent_approval` proposed by anyone else, or whose ask is not its
// need, is handed back without writing anything. Local only. Made-up data.

import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import {
  APPROVAL_PURPOSE,
  applyApprovals,
  type ApprovalOptions,
} from '../../apps/local-agent/approval.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  asAgent,
  asPerson,
  codeOf,
  createTask,
  handbackBody,
  liveWork,
  openSchedules,
  revisionOf,
  rows,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import { makeWorld, type World } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();
const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

let s: Schedules;
let world: World;

const options = (): ApprovalOptions => ({
  environment: { OPS_ENVIRONMENT: 'local' },
  database: s.db.app,
  businessId: s.business,
  agent: s.agent,
  home: world.agentHome,
});

const approvals = (): unknown => {
  const file = join(world.agentHome, 'approvals.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : undefined;
};

/** The owner's yes on the one approval waiting for it. */
async function approveThePending(): Promise<void> {
  const [gate] = await rows<{ gate_id: string; version_id: string }>(
    s,
    `select g.id as gate_id, v.id as version_id
       from public.gates g
       join public.proposal_versions v on v.business_id = g.business_id and v.id = g.version_id
      where g.business_id = $1 and g.state = 'pending' and v.purpose = $2`,
    [s.business, APPROVAL_PURPOSE],
  );
  if (gate === undefined) throw new Error('no pending gate');
  const decided = await asPerson(s, {
    command: 'task.decide',
    operationId: randomUUID(),
    gateId: gate.gate_id,
    versionId: gate.version_id,
    decision: 'approve',
    note: "the owner's yes on the local agent",
  });
  expect(codeOf(decided)).toBe('applied');
}

/** An approval with the given need and ask, proposed by the agent or by a person, then approved. */
async function approvedApproval(
  by: 'agent' | 'person',
  need: Record<string, unknown>,
  ask: string,
): Promise<void> {
  const payload = { localAgentApproval: need, ask };
  const step = { kind: APPROVAL_PURPOSE, payload: {} };
  const title = `Local ask ${randomUUID().slice(0, 8)}`;
  if (by === 'agent') {
    const work = await liveWork(s, title, 2_000);
    const successor = {
      purpose: APPROVAL_PURPOSE,
      maximumMinor: 1,
      currency: 'AUD',
      payload,
      step,
    };
    expect(codeOf(await asAgent(s, handbackBody(work.picked, successor)))).toBe('applied');
  } else {
    const taskId = await createTask(s, title);
    const proposed = await asPerson(s, {
      command: 'task.propose',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(s, taskId),
      purpose: APPROVAL_PURPOSE,
      maximumMinor: 1,
      currency: 'AUD',
      payload,
      step,
    });
    expect(codeOf(proposed)).toBe('applied');
  }
  await approveThePending();
}

beforeAll(async () => {
  s = await openSchedules('la1apprtrust', 1_000_000);
  world = makeWorld();
}, 180_000);

afterAll(async () => {
  world?.remove();
  await s?.db.drop();
});

it("an approval the tick's agent did not propose is never applied (review 2 M3)", async () => {
  await approvedApproval(
    'person',
    { kind: 'model', model: 'opus' },
    'Let the local agent run on opus',
  );
  expect(await applyApprovals(options())).toEqual({ ok: true, applied: [] });
  expect(approvals()).toBeUndefined();
}, 120_000);

it('an approval whose ask is not its need is never applied (review 2 M3)', async () => {
  await approvedApproval(
    'agent',
    { kind: 'model', model: 'opus' },
    "Raise the local agent's cap to USD 30",
  );
  expect(await applyApprovals(options())).toEqual({ ok: true, applied: [] });
  expect(approvals()).toBeUndefined();
}, 120_000);

it('approvals.json is written through a fresh private file, never a planted one (review 2 M4)', async () => {
  await approvedApproval(
    'agent',
    { kind: 'model', model: 'sonnet' },
    'Let the local agent run on sonnet',
  );
  const file = join(world.agentHome, 'approvals.json');
  const elsewhere = join(world.agentHome, '..', 'not-approvals.txt');
  world.write('.keep', '');
  writeFileSync(elsewhere, 'untouched\n');
  symlinkSync(elsewhere, `${file}.${String(process.pid)}.tmp`);
  expect(await applyApprovals(options())).toEqual({
    ok: true,
    applied: [{ kind: 'model', model: 'sonnet' }],
  });
  expect(readFileSync(elsewhere, 'utf8')).toBe('untouched\n');
  const written = lstatSync(file);
  expect(written.isFile()).toBe(true);
  expect(written.mode & 0o777).toBe(0o600);
  expect(approvals()).toEqual({ models: ['sonnet'] });
}, 120_000);
