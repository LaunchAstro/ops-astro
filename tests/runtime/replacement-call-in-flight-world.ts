// SPDX-License-Identifier: AGPL-3.0-only
//
// The steps the in-flight replacement call proofs share
// (`a-replacements-in-flight-model-call-stays-budgeted-when-the-original-is-written-off`,
// `a-replacements-in-flight-model-call-stays-budgeted-when-the-original-happened`): the pass
// proves a step's first attempt absent and reserves a replacement; a worker picks it up and
// starts a model call through the production broker, with no `task.dispatch`; while custody
// holds the request, a person closes the first attempt. Custody's answer is stubbed: no
// provider is paid.

import { expect } from 'vitest';
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
import { pickup, rows, type Detail, type Schedules } from './schedules-harness.ts';
import type { t3d1Harness } from './t3d1-harness.ts';
import { stopWorker } from './version-room-world.ts';
import type { Work } from './t2d-harness.ts';

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

type Harness = ReturnType<typeof t3d1Harness>;

/** The replacement's hold, lease and model call, and the task's envelope. */
export interface Seen {
  readonly hold: Record<string, unknown> | undefined;
  readonly envelope: Record<string, unknown> | undefined;
}

export interface ClosedWhileOut {
  readonly seen: { readonly whileOut: unknown; readonly answer: boolean; readonly answered: Seen };
  readonly stopped: () => Promise<Seen>;
}

async function seen(s: Schedules, h: Harness, w: Work, replacement: string): Promise<Seen> {
  const [hold] = await rows<Record<string, unknown>>(
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

/** The model call the replacement's worker asks for, under the lease its pickup took. */
async function callUnder(s: Schedules, w: Work, picked: Detail) {
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
  return { caller, request };
}

/**
 * The replacement's worker starts a model call, and a person `close`s the first attempt while
 * it is out: the replacement as seen then and once the call answers, and `stopped`, which
 * stops the worker and reads it again.
 */
export async function closedWhileTheReplacementsCallIsOut(
  s: Schedules,
  h: Harness,
  close: (w: Work) => Promise<void>,
): Promise<ClosedWhileOut> {
  const w = await h.unknownStep({ applied: false, room: true });
  expect(await h.reconcile()).toMatchObject([{ attemptId: w.attemptId, answer: 'absent' }]);
  const replacement = await h.replacement(w);
  if (replacement === undefined) throw new Error('the pass reserved no replacement');
  const picked: Detail = await pickup(s, replacement);
  const { caller, request } = await callUnder(s, w, picked);
  let whileOut: unknown;
  const broker = brokerOver(
    custodyAnswering(async () => {
      await close(w);
      whileOut = await seen(s, h, w, replacement);
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
    seen: { whileOut, answer: answer.ok, answered: await seen(s, h, w, replacement) },
    stopped: async () => {
      await stopWorker(s, picked);
      return await seen(s, h, w, replacement);
    },
  };
}
