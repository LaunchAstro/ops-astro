// SPDX-License-Identifier: AGPL-3.0-only
//
// S2282-2: a person's write-off stops the step's unmarked replacements
// (#2277), but never one whose broker model call is already in flight. The
// pass proves the first attempt absent and reserves a replacement; a worker
// picks it up and starts a model call through the production broker, with no
// `task.dispatch`. While custody holds the request, a person writes the first
// attempt off at nothing or above. The replacement keeps its hold and lease,
// so the call's later answer at 150 is charged on that hold, inside the
// envelope, and once the worker is stopped the envelope carries the write-off
// and the 150 once each. Custody's answer is stubbed here: no provider is paid.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  catalogue,
  REPLAY_COMPOSE,
  replayAdapter,
  replayCostMinor,
} from '../../packages/core-connectors/src/index.ts';
import {
  reserveModelCall,
  sendReservedCall,
  type Broker,
  type BrokerRoute,
  type Custody,
  type ModelCaller,
  type ModelCallRequest,
} from '../../packages/core-custody/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  appliedDetail,
  asPerson,
  openSchedules,
  pickup,
  rows,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';
import { writeOffBody } from './t3c-harness.ts';
import { openBilling, t3d1Harness } from './t3d1-harness.ts';
import { stopWorker } from './version-room-world.ts';
import type { Work } from './t2d-harness.ts';

const url = databaseUrlFromEnvironment();

if (url === undefined) {
  console.warn(
    'runtime/a-replacements-in-flight-model-call-stays-budgeted-when-the-original-is-written-off: DATABASE_URL is unset, so nothing below ran.',
  );
}

let s: Schedules;
const h = t3d1Harness(() => s);

beforeAll(async () => {
  if (url === undefined) return;
  s = await openSchedules('replacement_call_in_flight', 1_000_000);
  await openBilling(s);
  // The manager who stops the worker at the end.
  await s.db.app.withBusiness(s.business, async (tx) => await grantTo(tx, s.decider, 'manage'));
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

const ROUTE: BrokerRoute = {
  key: 'replay',
  reach: 'local',
  provider: 'replay',
  credentialRef: 'replay_key',
  credentialKind: 'api_key',
  installation: 'here',
  ceiling: 1_000,
};

const UNUSED = (): never => {
  throw new Error('custody is only asked to dispatch');
};

/** Custody that runs `meanwhile` while it holds the request, then answers at 50 + 2 * 50 = 150. */
const custodyAnswering = (meanwhile: () => Promise<void>): Custody => ({
  pid: 0,
  kill: UNUSED,
  stop: UNUSED,
  raw: UNUSED,
  stderr: () => '',
  describe: async () =>
    await Promise.resolve({
      credentialKind: 'api_key',
      account: null,
      presents: false,
      scheme: 'none',
    }),
  dispatch: async () => {
    await meanwhile();
    return {
      kind: 'answered',
      started: true,
      credentialKind: 'replay',
      account: null,
      outbound: {
        ok: true,
        status: 200,
        body: JSON.stringify({ text: 'synthetic', model: null, usage: { input: 50, output: 50 } }),
      },
    };
  },
});

const brokerOver = (custody: Custody): Broker => ({
  custody,
  operations: catalogue([REPLAY_COMPOSE]),
  providers: new Map([['replay', { build: replayAdapter, price: replayCostMinor }]]),
  routes: [ROUTE],
  installation: 'here',
  audit: async () => await Promise.resolve(),
});

/** The replacement's hold, lease and model call, and the task's envelope. */
async function seen(w: Work, replacement: string) {
  const [hold] = await rows(
    s,
    `select res.state, res.actual_minor::text as actual, l.state as lease_state,
            c.state as call_state, c.actual_minor::text as call_actual
       from public.reservations res
       join public.leases l on l.business_id = res.business_id and l.id = res.lease_id
       join public.model_calls c on c.business_id = res.business_id and c.reservation_id = res.id
      where res.business_id = $1 and res.id = $2`,
    [s.business, replacement],
  );
  return { hold, envelope: await h.envelope(w) };
}

/** The replacement's worker starts a model call, and `amount` is written off while it is out. */
async function writtenOffWhileTheReplacementsCallIsOut(amount: number) {
  const w = await h.unknownStep({ applied: false, room: true });
  expect(await h.reconcile()).toMatchObject([{ attemptId: w.attemptId, answer: 'absent' }]);
  const replacement = await h.replacement(w);
  if (replacement === undefined) throw new Error('the pass reserved no replacement');
  const picked: Detail = await pickup(s, replacement);
  const [attempt] = await rows<{ readonly step_id: string }>(
    s,
    'select step_id from public.attempts where business_id = $1 and id = $2',
    [s.business, picked['attemptId']],
  );
  const caller: ModelCaller = {
    actorId: s.agentActorId,
    delegationId: String(picked['delegationId']),
    attendedByPersonId: null,
  };
  const request: ModelCallRequest = {
    leaseId: String(picked['leaseId']),
    fence: Number(picked['fence']),
    stepId: String(attempt?.step_id),
    operation: REPLAY_COMPOSE.key,
    fields: [{ name: 'tone', from: { recordId: w.taskId, key: 'title' } }],
  };
  let whileOut: unknown;
  const broker = brokerOver(
    custodyAnswering(async () => {
      appliedDetail(await asPerson(s, writeOffBody(w, amount)), 'budget.write_off');
      whileOut = await seen(w, replacement);
    }),
  );
  const held = await s.db.app.withBusiness(
    s.business,
    async (tx) => await reserveModelCall(tx, caller, request, broker),
  );
  if (!held.ok) throw new Error(`the broker refused the hold: ${held.code}`);
  const answer = await sendReservedCall(
    s.db.app,
    s.business,
    caller,
    request,
    held.reserved,
    broker,
  );
  return {
    seen: { whileOut, answer: answer.ok, answered: await seen(w, replacement) },
    stopped: async () => {
      await stopWorker(s, picked);
      return await seen(w, replacement);
    },
  };
}

describe.skipIf(url === undefined)(
  "a replacement's in-flight model call stays budgeted when the original is written off",
  { timeout: 60_000 },
  () => {
    it.each([0, 700])(
      'written off at %i while the call is out, the answer at 150 is charged once inside the envelope',
      async (amount) => {
        const { seen: out, stopped } = await writtenOffWhileTheReplacementsCallIsOut(amount);
        const live = { state: 'held', actual: null, lease_state: 'live', call_actual: null };
        // The envelope still holds the replacement's 2500, which carries the call, and the
        // written-off figure; the answer moves neither, so it is never counted twice.
        const held = { held: '2500', actual: String(amount), maximum: '5000' };
        expect(out).toStrictEqual({
          whileOut: { hold: { ...live, call_state: 'dispatched' }, envelope: held },
          answer: true,
          answered: {
            hold: { ...live, call_state: 'settled', call_actual: '150' },
            envelope: held,
          },
        });
        // Stopped, the replacement settles at its call's 150 and gives the rest back.
        expect(await stopped()).toMatchObject({
          hold: { state: 'actual', actual: '150', call_state: 'settled', call_actual: '150' },
          envelope: { held: '0', actual: String(amount + 150) },
        });
      },
    );
  },
);
