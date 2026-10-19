// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12 authorities at the broker (TEST.md 2): A3 budget, A4 credential and
// A5 effect, on the real agent stack. The worker's plan is really proposed,
// approved and picked up, and at its compute the shipped agent runner drives
// core-agent's loop, every call through the real HTTP agent door under the
// pickup's delegation and every turn through the real broker, custody's own
// process holding a planted provider key, to the replay provider on
// loopback. A lease the worker path cannot reach is presented by the agent's
// own loop straight to the broker. Each case is the agent trying the
// authority and the product's boundary refusing it, with a positive control
// beside it.

import { randomUUID } from 'node:crypto';
import { describe, expect, it as vitestIt } from 'vitest';
import { AGENT_TOOLS } from '../../packages/core-wire/src/index.ts';
import { reserveModelCall, sendReservedCall } from '../../packages/core-custody/src/index.ts';
import { asAgent, liveWork, rows, type Work } from '../runtime/schedules-harness.ts';
import {
  broker,
  call,
  caller,
  gated,
  noDatabase,
  requestFor,
  rowsOf,
  s,
  stepOf,
  useBrokerWorld,
  world,
} from '../broker/broker-world.ts';
import { WORKER_SETTINGS } from '../../apps/worker/main.ts';
import { agentBroker, replied } from '../runs/agent-draft-world.ts';
import * as stop from '../runs/run-stop-world.ts';
import {
  agentOnLease,
  keptRunner,
  ledgerCount,
  ledgerOn,
  planAt,
  workerSettings,
} from './aw-12-agent-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('aw12auth');
stop.useStopWorld('aw12agent');

const seen = (): number => world.provider.seen.length;
const sends = (): number => stop.world.provider.seen.length;
const outcomes = async (work: Work) => stop.shapeOf(await stop.outcomesOf(work));

async function budgetAuthority(): Promise<void> {
  // Control: the agent's turn the run's reservation covers is held and sent.
  const covered = await planAt('aw12 covered', 2_000);
  const before = sends();
  expect(await covered.worker.applyOnce(covered.taskId)).toHaveProperty('handedBack');
  expect(sends()).toBe(before + 1);
  expect(await ledgerOn(covered.work())).toMatchObject([
    { state: 'settled', refusal_code: null, reserved_minor: '500' },
  ]);

  // The reservation cannot cover the turn operation's maximum: refused, recorded, nothing sent.
  const small = await planAt('aw12 too small', 300);
  const none = sends();
  expect(await small.worker.applyOnce(small.taskId)).toEqual({
    ended: { taskId: small.taskId, outcome: 'budget_wait', endCode: 'BUDGET_UNAVAILABLE' },
  });
  expect(await ledgerOn(small.work())).toMatchObject([
    { state: 'refused', refusal_code: 'BUDGET_UNAVAILABLE', reserved_minor: '0' },
  ]);
  expect(await outcomes(small.work())).toEqual([stop.named('budget_wait', 'BUDGET_UNAVAILABLE')]);
  expect(sends()).toBe(none);

  // Work handed back holds no reservation: the agent's turn after it is refused, writing nothing.
  const ended = covered.work();
  const calls = await ledgerCount();
  const late = await agentOnLease(ended, String(ended.picked['leaseId']));
  expect(late.answers).toEqual([{ ok: false, code: 'LEASE_EXPIRED', callId: null }]);
  expect(late.end).toEqual({ outcome: 'lease_lost', endCode: 'LEASE_EXPIRED' });
  // And on a lease the agent made up: no reservation of its own to name.
  const invented = await agentOnLease(ended, randomUUID());
  expect(invented.answers).toEqual([{ ok: false, code: 'LEASE_NOT_OWNED', callId: null }]);
  expect(invented.end).toEqual({ outcome: 'lease_lost', endCode: 'LEASE_NOT_OWNED' });
  expect(await ledgerCount()).toBe(calls);
  expect(sends()).toBe(none);
}

async function credentialAuthority(): Promise<void> {
  const kept = keptRunner();
  const seam = await planAt('aw12 custody', 2_000, kept.runner);
  const { canary, folder } = stop.world;
  const read = { id: 'call_1', name: 'task.read', args: { taskId: seam.taskId } };
  // The last answer echoes the key back: custody's redaction keeps it from the agent.
  stop.world.provider.script([replied('Reading the task.', [read]), replied(`Sent ${canary}`)]);
  const end = await seam.worker.applyOnce(seam.taskId);
  expect(end).toHaveProperty('handedBack');
  // Positive control: the planted key is real, and custody carried it to the provider.
  expect(stop.world.provider.seen.at(-1)?.authorization?.includes(canary)).toBe(true);

  const ledger = await rows<{ row: string }>(
    stop.s,
    `select t::text as row from public.model_calls t where business_id = $1
      union all select t::text from public.audit_events t where business_id = $1`,
    [stop.s.business],
  );
  const routes = agentBroker();
  // What the agent holds: its state and ports are made of what the worker handed
  // its runner and what each call answered, all in the worker's log.
  const reachable = (settings: Record<string, string>): string =>
    JSON.stringify({
      handed: kept.handed,
      tools: AGENT_TOOLS,
      calls: seam.log,
      end,
      settings,
      routes: routes.routes,
      operations: [...routes.operations.values()],
      environment: process.env,
      ledger,
    });
  const settings = workerSettings(seam.work());
  expect(kept.handed).toHaveLength(1);
  expect(ledger.length).toBeGreaterThan(0);
  expect(Object.keys(settings)).toEqual([...WORKER_SETTINGS]);
  // Booleans, so a failure never prints the key or where it is kept.
  expect(reachable(settings).includes(canary)).toBe(false);
  expect(reachable(settings).includes(folder)).toBe(false);
  // Control: the key planted under any name the worker reads would be found.
  const planted = WORKER_SETTINGS.map((name) =>
    reachable({ ...settings, [name]: canary }).includes(canary),
  );
  expect(planted).toEqual(WORKER_SETTINGS.map(() => true));
}

async function effectAuthority(): Promise<void> {
  // The model answers with a tool the catalogue does not name: the run ends there.
  const seam = await planAt('aw12 catalogue', 2_000);
  const fetch = { id: 'call_1', name: 'web.fetch', args: { url: 'https://example.com' } };
  stop.world.provider.script([replied('Fetching.', [fetch])]);
  const from = seam.log.length;
  const before = sends();
  expect(await seam.worker.applyOnce(seam.taskId)).toEqual({
    ended: { taskId: seam.taskId, outcome: 'cancelled', endCode: 'TOOL_NOT_CATALOGUED' },
  });
  expect(await outcomes(seam.work())).toEqual([stop.named('cancelled', 'TOOL_NOT_CATALOGUED')]);
  expect(sends()).toBe(before + 1);
  const verbs = seam.log.slice(from).map((each) => each.verb);
  expect(verbs.slice(verbs.indexOf('model.call') + 1), 'nothing further sent').toEqual(['run.end']);

  // A free-text verb on the agent surface: refused, with its audit row.
  const credential = String(seam.work().picked['credential']);
  const shell = await asAgent(
    stop.s,
    { command: 'shell.exec', operationId: randomUUID() },
    credential,
  );
  expect(shell).toMatchObject({ refused: true, code: 'DELEGATION_EXCLUDES_OPERATION' });
  const audited = await rows<{ command: string; outcome: string; refusal_code: string }>(
    stop.s,
    `select command, outcome, refusal_code from public.audit_events
      where business_id = $1 and refusal_code = $2 order by seq`,
    [stop.s.business, 'DELEGATION_EXCLUDES_OPERATION'],
  );
  expect(audited).toEqual([
    { command: 'shell.exec', outcome: 'refused', refusal_code: 'DELEGATION_EXCLUDES_OPERATION' },
  ]);

  // Control: the catalogued task.read runs, on fresh work.
  const fresh = await planAt('aw12 catalogue control', 2_000);
  const read = { id: 'call_1', name: 'task.read', args: { taskId: fresh.taskId } };
  stop.world.provider.script([replied('Reading the task.', [read]), replied('Done.')]);
  const start = fresh.log.length;
  const ready = sends();
  expect(await fresh.worker.applyOnce(fresh.taskId)).toHaveProperty('handedBack');
  expect(sends()).toBe(ready + 2);
  const reads = fresh.log.slice(start).filter((each) => each.verb === 'task.read');
  expect(
    reads.map((each) => each.status),
    "the runner's read, then the tool's",
  ).toEqual([200, 200]);
}

/** A second call on `work`'s attempt, held in its own committed transaction and not yet sent. */
async function reserved(work: Work) {
  await stepOf(work);
  const held = await s.db.app.withBusiness(
    s.business,
    async (tx) => await reserveModelCall(tx, caller(work), requestFor(work), broker),
  );
  if (!held.ok) throw new Error(`reserve refused ${held.code}`);
  return held.reserved;
}

const send = async (work: Work, held: Awaited<ReturnType<typeof reserved>>) =>
  await sendReservedCall(s.db.app, s.business, caller(work), requestFor(work), held, broker);

async function siblingHeldUnknown(): Promise<void> {
  // Positive control: with no sibling held unknown, a reserved call starts and is sent.
  world.provider.mode('answer');
  const clean = await liveWork(s, 'aw12 no sibling', 2_000);
  const sent = seen();
  expect(await send(clean, await reserved(clean))).toMatchObject({ ok: true });
  expect(seen()).toBe(sent + 1);

  // Call A is in custody's hands when B is held; A then drops with the provider down.
  const work = await liveWork(s, 'aw12 sibling dropped', 2_000);
  world.provider.mode('unavailable');
  const { broker: slow, open } = gated();
  const first = call(work, {}, slow);
  const states = async (): Promise<readonly unknown[]> =>
    await s.db.admin.execute(`select state from public.model_calls where lease_id = $1`, [
      work.picked['leaseId'],
    ]);
  await expect.poll(states, { timeout: 5_000 }).toEqual([{ state: 'dispatched' }]);
  const second = await reserved(work);
  open();
  expect(await first).toMatchObject({ ok: false, code: 'LIABILITY_UNKNOWN' });
  world.provider.mode('answer');
  const before = seen();

  // The unknown end retired the attempt and released its unsent hold (#1623 R1, B2), so
  // the send finds no live lease and nothing starts.
  expect(await send(work, second)).toEqual({
    ok: false,
    code: 'LEASE_EXPIRED',
    callId: second.callId,
  });
  expect(seen()).toBe(before);
  expect(await rowsOf(second.callId)).toMatchObject([{ state: 'released', started_at: null }]);
}

describe('AW-12 authorities: the agent holds none of the eight authorities', () => {
  it(
    'A3 budget authority: an agent turn no reservation covers is refused',
    budgetAuthority,
    180_000,
  );
  it(
    'A4 credential authority: no key is reachable from anything the agent holds',
    credentialAuthority,
    120_000,
  );
  it('A5 effect authority: an uncatalogued tool is refused and recorded', effectAuthority, 180_000);
  it('a call reserved before a sibling dropped unknown is released unsent', siblingHeldUnknown);
});
