// SPDX-License-Identifier: AGPL-3.0-only
//
// What AW-12's authority proofs need of the real agent stack, on the stop
// world (`../runs/run-stop-world.ts`): the worker's plan at a reservation the
// case names, computed by the shipped agent runner, with what the worker
// handed that runner kept; and the agent's own loop on a lease the worker
// path cannot reach (handed back, or made up), each turn through the real
// broker as the door builds it. `s` and `world` are the stop world's live
// bindings, read by the cases after its beforeAll.

import { auditAs } from '../../packages/core-commands/src/commands/model-call.ts';
import { REPLAY_TURN } from '../../packages/core-connectors/src/index.ts';
import {
  callModel,
  type Broker,
  type ModelCallResult,
} from '../../packages/core-custody/src/index.ts';
import { lockDropAtSettlement } from '../../packages/core-runtime/src/index.ts';
import {
  attemptState,
  runAttempt,
  type AttemptEnd,
  type BrokerPort,
} from '../../packages/core-agent/src/index.ts';
import {
  AGENT_MODEL_CALL_LIMIT,
  AGENT_TOOLS,
  type EndCode,
} from '../../packages/core-wire/src/index.ts';
import { agentRunner } from '../../apps/worker/agent-runner.ts';
import { WORKER_SETTINGS, type WorkerSetting } from '../../apps/worker/main.ts';
import type { StepContext, StepRunner } from '../../apps/worker/step-runner.ts';
import { SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';
import { createWorker } from '../../apps/worker/worker.ts';
import { approve, revisionOf, rows, type Work } from '../runtime/schedules-harness.ts';
import { agentBroker } from '../runs/agent-draft-world.ts';
import { unproposed, type Seam } from '../runs/compute-seam-world.ts';
import { s } from '../runs/run-stop-world.ts';

/** The shipped agent runner, and what the worker handed it at each compute: all its ports are made of. */
export function keptRunner(): {
  readonly runner: StepRunner;
  readonly handed: Omit<StepContext, 'call'>[];
} {
  const handed: Omit<StepContext, 'call'>[] = [];
  const shipped = agentRunner({ operation: REPLAY_TURN.key });
  const runner: StepRunner = {
    compute: async (context) => {
      const { call: _call, ...rest } = context;
      handed.push(rest);
      return await shipped.compute(context);
    },
  };
  return { runner, handed };
}

/**
 * The worker's plan on a fresh task, its step held at `maximumMinor`,
 * accepted and not launched, computed by `runner` (the shipped agent
 * runner unless one is given) through the door's broker with the turn
 * operation. `acceptedPlan`'s, with the reservation the case names.
 */
export async function planAt(
  title: string,
  maximumMinor: number,
  runner: StepRunner = agentRunner({ operation: REPLAY_TURN.key }),
): Promise<Seam> {
  const { taskId, log, options } = await unproposed(title, runner, agentBroker());
  const worker = createWorker({
    ...options,
    reporter: { ...SYNTHETIC_USAGE, estimate: () => maximumMinor },
  });
  const proposed = await worker.proposeOnce();
  if (!('proposed' in proposed)) throw new Error(`setup: propose ${JSON.stringify(proposed)}`);
  const [gate] = await rows<{ version_id: string; lineage_id: string }>(
    s,
    'select version_id::text as version_id, lineage_id::text as lineage_id from public.gates where id = $1',
    [proposed.proposed.gateId],
  );
  if (gate === undefined) throw new Error('setup: the proposal has no gate');
  await approve(s, { gateId: proposed.proposed.gateId, versionId: gate.version_id });
  const work = (): Work => {
    const picked = log.find((sent) => sent.verb === 'task.pickup' && sent.status === 200);
    if (picked === undefined) throw new Error('the worker picked nothing up');
    return {
      taskId,
      proposal: { lineageId: gate.lineage_id },
      decision: {},
      picked: picked.detail,
    };
  };
  return { taskId, planVersionId: gate.version_id, lineageId: gate.lineage_id, log, worker, work };
}

/** The door's broker for `model.call`, its audit as the agent's. */
const doorBroker = (): Broker => ({
  ...agentBroker(),
  audit: auditAs(s.agentActorId),
  drops: lockDropAtSettlement,
});

/** What the agent's own loop on a lease ended with, and each answer the broker gave it. */
export interface OnLease {
  readonly end: AttemptEnd;
  readonly answers: readonly ModelCallResult[];
  readonly ended: readonly EndCode[];
}

/**
 * The agent's loop on `work`'s task, presenting `leaseId` under the work's
 * delegation. Each turn is the real broker's `call`, its step the lease's
 * own attempt's as the door finds it; the stop it ends with is kept, not sent.
 */
export async function agentOnLease(work: Work, leaseId: string): Promise<OnLease> {
  const [step] = await rows<{ step_id: string }>(
    s,
    'select step_id::text as step_id from public.attempts where business_id = $1 and lease_id = $2',
    [s.business, leaseId],
  );
  const caller = {
    actorId: s.agentActorId,
    delegationId: String(work.picked['delegationId']),
    attendedByPersonId: null,
  };
  const answers: ModelCallResult[] = [];
  const broker: BrokerPort = {
    turn: async (turn) => {
      const request = {
        leaseId,
        fence: Number(work.picked['fence']),
        stepId: step?.step_id ?? '',
        operation: REPLAY_TURN.key,
        fields: [],
        turn,
      };
      const answer = await callModel(s.db.app, s.business, caller, request, doorBroker());
      answers.push(answer);
      if (!answer.ok) return { stopped: answer.code as EndCode, recorded: false };
      return { callId: answer.callId, text: answer.text, toolCalls: answer.toolCalls ?? [] };
    },
  };
  const ended: EndCode[] = [];
  const state = attemptState(work.taskId, await revisionOf(s, work.taskId), AGENT_TOOLS);
  const ports = {
    broker,
    tools: new Map(),
    end: async (code: EndCode) => {
      ended.push(code);
      await Promise.resolve();
    },
  };
  const end = await runAttempt(state, ports, AGENT_MODEL_CALL_LIMIT, undefined, 'The task.');
  return { end, answers, ended };
}

/** What a worker is handed for this work, under every name it reads (`apps/worker/main.ts`). */
export const workerSettings = (work: Work): Record<string, string> => {
  const given: Record<WorkerSetting, string> = {
    OPS_ASTRO_BUSINESS: s.business,
    OPS_ASTRO_EMAIL: `agent-${s.agentActorId}@example.test`,
    OPS_ASTRO_PASSWORD: `agent-password-${s.agentActorId}`,
    OPS_ASTRO_GOTRUE_URL: 'http://127.0.0.1:54391',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example-test-only',
    OPS_ASTRO_DELEGATION: String(work.picked['credential']),
    OPS_ASTRO_API_URL: 'http://127.0.0.1:8790',
    OPS_ASTRO_WORKER_INTERVAL_MS: '5000',
    OPS_WORKER_HEARTBEAT_URL: 'https://beat.example.com/ping',
    OPS_EGRESS_HEARTBEAT_HOST: 'beat.example.com',
    OPS_EGRESS_AUTH_HOST: 'auth.example.com',
    OPS_HEARTBEAT_EVERY_MS: '240000',
  };
  return Object.fromEntries(WORKER_SETTINGS.map((name) => [name, given[name]]));
};

/** The business's model calls, all of them. */
export const ledgerCount = async (): Promise<number> =>
  Number(
    (
      await rows<{ n: string }>(
        s,
        'select count(*)::text as n from public.model_calls where business_id = $1',
        [s.business],
      )
    )[0]?.n,
  );

/** The lease's model calls, oldest first, refused steps among them. */
export const ledgerOn = async (work: Work): Promise<readonly Record<string, unknown>[]> =>
  await rows(
    s,
    `select state, refusal_code, reserved_minor::text as reserved_minor, operation_key
       from public.model_calls where business_id = $1 and lease_id = $2 order by accepted_at, id`,
    [s.business, work.picked['leaseId']],
  );
