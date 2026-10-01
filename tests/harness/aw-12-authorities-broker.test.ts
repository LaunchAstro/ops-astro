// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12 authorities at the broker (TEST.md 2): A3 budget, A4 credential and
// A5 effect. The framework stand-in sits where a worker sits, handed the
// broker's model call and tools by name, over the AW-01 broker world: work
// really proposed, approved and picked up, custody's own process holding a
// planted provider key, and the replay provider on loopback. Each case is the
// framework trying the authority on its own initiative and the product's
// boundary refusing it, with a positive control beside it.

import { randomUUID } from 'node:crypto';
import { describe, expect, it as vitestIt } from 'vitest';
import { REPLAY_COMPOSE } from '../../packages/core-connectors/src/index.ts';
import {
  reserveModelCall,
  sendReservedCall,
  type ModelCallResult,
} from '../../packages/core-custody/src/index.ts';
import { asAgent, handbackBody, liveWork, rows, type Work } from '../runtime/schedules-harness.ts';
import {
  broker,
  call,
  callCount,
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
import { WORKER_SETTINGS, type WorkerSetting } from '../../apps/worker/main.ts';
import { standIn, type StandIn } from './framework-stand-in.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('aw12auth');

/** What a worker is handed for this work, under every name it reads (`apps/worker/main.ts`). */
const workerSettings = (work: Work): Record<string, string> => {
  const given: Record<WorkerSetting, string> = {
    OPS_ASTRO_BUSINESS: s.business,
    OPS_ASTRO_TOKEN: `agent-bearer-${s.agentActorId}`,
    OPS_ASTRO_DELEGATION: String(work.picked['credential']),
    OPS_ASTRO_API_URL: 'http://127.0.0.1:8790',
    OPS_ASTRO_WORKER_INTERVAL_MS: '5000',
    OPS_WORKER_HEARTBEAT_URL: 'https://beat.example.com/ping',
    OPS_EGRESS_HEARTBEAT_HOST: 'beat.example.com',
  };
  return Object.fromEntries(WORKER_SETTINGS.map((name) => [name, given[name]]));
};

/** Everything the stand-in can reach, as text: the A4 scan's haystack. */
const reachableFrom = (held: StandIn, rest: Record<string, unknown>): string =>
  JSON.stringify({
    settings: held.config.settings,
    tools: [...held.config.tools.keys()],
    store: [...held.store],
    ...rest,
  });

/** The stand-in on `work`: its one model client is the broker, on the lease it holds. */
function framework(
  work: Work,
  tools: [string, (input: string) => Promise<unknown>][] = [],
  model: () => Promise<unknown> = async () => await call(work),
): StandIn {
  return standIn({
    settings: workerSettings(work),
    model,
    tools: new Map(tools),
    retries: 0,
    read: (reply) => ((reply as ModelCallResult).ok ? { ok: true } : { ok: false, why: 'refused' }),
  });
}

const seen = (): number => world.provider.seen.length;

async function budgetAuthority(): Promise<void> {
  world.provider.mode('answer');
  // Control: a compaction the run's reservation covers goes through the broker and is held.
  const covered = await liveWork(s, 'aw12 covered', 2_000);
  const held = framework(covered);
  held.plan(covered.taskId, ['read the brief', 'draft']);
  expect(await held.compact(covered.taskId)).toMatchObject({ ok: true, reservedMinor: 500 });

  // The reservation cannot cover the operation's maximum: refused, recorded, nothing sent.
  const before = seen();
  const small = await liveWork(s, 'aw12 too small', 300);
  const short = (await framework(small).compact(small.taskId)) as ModelCallResult;
  expect(short).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE' });
  expect(await rowsOf((short as { callId: string }).callId)).toMatchObject([
    { state: 'refused', refusal_code: 'BUDGET_UNAVAILABLE', reserved_minor: '0' },
  ]);

  // Work handed back holds no reservation: a compaction after it is refused, writing nothing.
  const ended = await liveWork(s, 'aw12 handed back', 2_000);
  const late = framework(ended);
  await asAgent(s, handbackBody(ended.picked), String(ended.picked['credential']));
  const calls = await callCount();
  expect(await late.compact(ended.taskId)).toEqual({
    ok: false,
    code: 'LEASE_EXPIRED',
    callId: null,
  });
  // And on a lease the framework made up: no reservation of its own to name.
  const invented = framework(ended, [], async () => await call(ended, { leaseId: randomUUID() }));
  expect(await invented.compact(ended.taskId)).toEqual({
    ok: false,
    code: 'LEASE_NOT_OWNED',
    callId: null,
  });
  expect(await callCount()).toBe(calls);
  expect(seen()).toBe(before);
}

async function credentialAuthority(): Promise<void> {
  world.provider.mode('answer');
  const work = await liveWork(s, 'aw12 custody', 2_000);
  const held = framework(work, [['compose', async () => await call(work)]]);
  const answers = [await held.compact(work.taskId), await held.callTool('compose', '')];
  expect(answers).toMatchObject([{ ok: true }, { ok: true }]);
  // Positive control: the planted key is real, and custody carried it to the provider.
  expect(world.provider.seen.at(-1)?.authorization?.includes(world.canary)).toBe(true);

  const ledger = await rows<{ row: string }>(
    s,
    `select t::text as row from public.model_calls t where business_id = $1
      union all select t::text from public.audit_events t where business_id = $1`,
    [s.business],
  );
  const reachable = reachableFrom(held, {
    answers,
    routes: broker.routes,
    operations: [...broker.operations.values()],
    environment: process.env,
    ledger,
  });
  expect(ledger.length).toBeGreaterThan(0);
  expect(Object.keys(held.config.settings)).toEqual([...WORKER_SETTINGS]);
  // Booleans, so a failure never prints the key or where it is kept.
  expect(reachable.includes(world.canary)).toBe(false);
  expect(reachable.includes(world.folder)).toBe(false);
  // Control: the key planted under any name the worker reads would be found.
  const planted = WORKER_SETTINGS.map((name) => {
    const leaky = framework(work);
    const settings = { ...leaky.config.settings, [name]: world.canary };
    return reachableFrom({ ...leaky, config: { ...leaky.config, settings } }, {}).includes(
      world.canary,
    );
  });
  expect(planted).toEqual(WORKER_SETTINGS.map(() => true));
}

async function effectAuthority(): Promise<void> {
  world.provider.mode('answer');
  const work = await liveWork(s, 'aw12 catalogue', 2_000);
  const credential = String(work.picked['credential']);
  const shell = randomUUID();
  const held = framework(work, [
    ['web.fetch', async () => await call(work, { operation: 'web.fetch' })],
    ['compose', async () => await call(work, { operation: REPLAY_COMPOSE.key })],
    [
      'shell.exec',
      async () => await asAgent(s, { command: 'shell.exec', operationId: shell }, credential),
    ],
  ]);
  const before = seen();

  // A model operation the broker never registered: refused and recorded as a step.
  const fetched = (await held.callTool('web.fetch', 'https://example.com')) as ModelCallResult;
  expect(fetched).toMatchObject({ ok: false, code: 'OPERATION_NOT_CATALOGUED' });
  const callId = (fetched as { callId: string | null }).callId;
  expect(callId).toEqual(expect.any(String));
  expect(await rowsOf(callId)).toMatchObject([
    { state: 'refused', refusal_code: 'OPERATION_NOT_CATALOGUED', operation_key: 'web.fetch' },
  ]);
  // A free-text verb on the agent surface: refused, with its audit row.
  expect(await held.callTool('shell.exec', 'ls')).toMatchObject({
    refused: true,
    code: 'DELEGATION_EXCLUDES_OPERATION',
  });
  const audited = await rows<{ command: string; outcome: string; refusal_code: string }>(
    s,
    `select command, outcome, refusal_code from public.audit_events
      where business_id = $1 and refusal_code in ($2, $3) order by seq`,
    [s.business, 'OPERATION_NOT_CATALOGUED', 'DELEGATION_EXCLUDES_OPERATION'],
  );
  expect(audited).toEqual([
    {
      command: 'model.call_refused',
      outcome: 'refused',
      refusal_code: 'OPERATION_NOT_CATALOGUED',
    },
    { command: 'shell.exec', outcome: 'refused', refusal_code: 'DELEGATION_EXCLUDES_OPERATION' },
  ]);
  expect(seen()).toBe(before);
  // Control: the catalogued operation goes through.
  expect(await held.callTool('compose', '')).toMatchObject({ ok: true });
  expect(seen()).toBe(before + 1);
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

  expect(await send(work, second)).toEqual({
    ok: false,
    code: 'LIABILITY_UNKNOWN',
    callId: second.callId,
  });
  expect(seen()).toBe(before);
  expect(await rowsOf(second.callId)).toMatchObject([{ state: 'released', started_at: null }]);
}

describe('AW-12 authorities: a framework holds none of the eight authorities', () => {
  it(
    'A3 budget authority: a framework-initiated model call without a reservation is refused',
    budgetAuthority,
  );
  it(
    'A4 credential authority: no key is reachable from framework configuration or tools',
    credentialAuthority,
  );
  it('A5 effect authority: an uncatalogued tool is refused and recorded', effectAuthority);
  it(
    'a call reserved before a sibling dropped unknown is released unsent at start',
    siblingHeldUnknown,
  );
});
