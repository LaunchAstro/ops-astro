// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R2: the shipped worker over R1's stop world, with a step runner the
// case scripts. The worker proposes its own synthetic change under a
// delegation minted for the task, a person accepts the plan, and the worker's
// pass meets `LAUNCH_NOT_DECIDED` at dispatch (design R3). Every worker call
// goes through the real HTTP agent door (`run-stop-world.ts`), and the
// transport keeps the order they were sent in, so a case can say what the
// worker did and what it never did before a Launch.
//
// The seam as these proofs drive it: `createWorker`'s `runner` option, whose
// `compute(context)` the worker calls with `context.phase === 'compute'` and
// which answers a `StepEnd`, the `{ outcome, endCode }` pair `outcomeOf`
// gives (design D1). A tree with no such option ignores it, so the red there
// is the runner never being called, not a type error.
//
// The scripted runner acts as the agent runner would: its own calls (a task
// read, a model turn, its own `run.end`) go through the door under the plan's
// lease, which it reads from the pickup the worker was answered. Outcomes are
// read only through `run-outcomes-read.ts`.

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { auditAs, type ModelBroker } from '../../packages/core-commands/src/commands/model-call.ts';
import { catalogue, REPLAY_COMPOSE } from '../../packages/core-connectors/src/index.ts';
import { reserveModelCall, type Broker } from '../../packages/core-custody/src/index.ts';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/index.ts';
import type { Transport } from '../../apps/cli/client.ts';
import { COMPUTES_NOTHING } from '../support/computes-nothing-runner.ts';
import { createWorker, type WorkerOptions } from '../../apps/worker/worker.ts';
import { SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';
import { tokenFor } from '../api/fixture.ts';
import { approve, createTask, rows, type Work } from '../runtime/schedules-harness.ts';
import { attemptOfLease } from './run-outcomes-read.ts';
import { brokerOver, door, s } from './run-stop-world.ts';

/** What a step ends with, as the scripted runner answers it. */
export interface StepEnd {
  readonly outcome: string;
  readonly endCode: string;
}

/** One worker call as the transport sent it, or the runner's compute between them. */
export interface Sent {
  readonly verb: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly status: number;
  readonly detail: Readonly<Record<string, unknown>>;
}

/** The facts at the moment the worker called `compute`, read on the database. */
export interface AtCompute {
  readonly phase: unknown;
  /** The lease the worker was handed at pickup, still live. */
  readonly leaseLive: boolean;
  /** That lease serves the accepted plan's own version, not a launched successor. */
  readonly planLease: boolean;
  /** Person decisions on the task's gates so far: the plan's accept alone. */
  readonly decisions: number;
}

/** A runner whose `compute` runs `script` under the plan's lease and answers its end. */
export interface Scripted {
  readonly runner: { readonly compute: (context: unknown) => Promise<StepEnd> };
  readonly computed: AtCompute[];
}

/** Retired between cases: one live pickup delegation per purpose (`DELEGATION_ALREADY_LIVE`). */
export async function retirePickups(): Promise<void> {
  await s.db.admin.execute(
    `update public.delegations set revoked_at = now(), revocation_cause = 'work_retired'
      where business_id = $1 and agent_actor_id = $2 and purpose = 'synthetic_comment'
        and revoked_at is null and settled_at is null`,
    [s.business, s.agentActorId],
  );
}

/** The verb a door path names: `/api/a/b/<key>/task/pickup` is `task.pickup`. */
const verbOf = (path: string): string => path.split('/').slice(5).join('.');

const transportOver = (app: Hono, log: Sent[]): Transport =>
  async function send(path, body, bearer, delegation) {
    const response = await app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
        ...(delegation === undefined ? {} : { [DELEGATION_HEADER]: delegation }),
      },
      body,
    });
    const answer = (await response
      .clone()
      .json()
      .catch(() => ({}))) as { readonly detail?: Readonly<Record<string, unknown>> };
    log.push({
      verb: verbOf(path),
      body: JSON.parse(body) as Sent['body'],
      status: response.status,
      detail: answer.detail ?? {},
    });
    return response;
  };

/** One task the worker proposes on, its plan accepted by the person, and the worker to work it. */
export interface Seam {
  readonly taskId: string;
  readonly planVersionId: string;
  readonly lineageId: string;
  readonly log: Sent[];
  readonly worker: ReturnType<typeof createWorker>;
  /** The work as the pickup answered it: the plan's lease, fence and credential. */
  readonly work: () => Work;
}

async function delegationFor(taskId: string): Promise<string> {
  return await s.db.app.withBusiness(s.business, async (tx) => {
    const minted = await mintDelegation(tx, {
      agentActorId: s.agentActorId,
      delegatePersonId: s.decider.personId,
      mintedByActorId: s.decider.actorId,
      purpose: `seam_${randomUUID().slice(0, 8)}`,
      collections: ['task'],
      actions: ['read', 'comment', 'write'],
      purposeScope: { kind: 'record', id: taskId },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!minted.ok) throw new Error(`setup: mint refused ${minted.refusal.code}`);
    return minted.value.credential;
  });
}

/**
 * The worker's plan on a fresh task, accepted and not launched. `runner` is the
 * worker's own (scripted, the shipped agent's, or else one computing nothing);
 * `broker` is the door's `model.call` broker (one with the turn operation,
 * for the agent runner); `around` wraps the worker's transport.
 */
export async function acceptedPlan(
  title: string,
  runner?: Scripted['runner'] | WorkerOptions['runner'],
  broker?: ModelBroker,
  around?: (transport: Transport) => Transport,
): Promise<Seam> {
  const { taskId, log, options } = await unproposed(title, runner, broker, around);
  const worker = createWorker(options);
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

/** A fresh task and the options a worker on it is made with (a second shares its delegation), nothing proposed. */
export async function unproposed(
  title: string,
  runner?: Scripted['runner'] | WorkerOptions['runner'],
  broker?: ModelBroker,
  around: (transport: Transport) => Transport = (transport) => transport,
): Promise<{ readonly taskId: string; readonly log: Sent[]; readonly options: WorkerOptions }> {
  await retirePickups();
  const taskId = await createTask(s, `${title} ${randomUUID()}`);
  const [business] = await rows<{ key: string }>(
    s,
    'select key from public.businesses where id = $1',
    [s.business],
  );
  const log: Sent[] = [];
  const options: WorkerOptions = {
    transport: around(transportOver(door(undefined, broker), log)),
    businessKey: String(business?.key),
    credential: await tokenFor(s.agent.subject),
    delegation: await delegationFor(taskId),
    reporter: SYNTHETIC_USAGE,
    runner: (runner ?? COMPUTES_NOTHING) as WorkerOptions['runner'],
  };
  return { taskId, log, options };
}

/** Person decisions recorded on the task's lineages. */
export const decisionsOn = async (taskId: string): Promise<number> => {
  const [found] = await rows<{ n: number }>(
    s,
    `select count(*)::int as n from public.gate_decisions d
       join public.proposal_lineages l on l.business_id = d.business_id and l.id = d.lineage_id
      where l.business_id = $1 and l.task_id = $2`,
    [s.business, taskId],
  );
  return Number(found?.n);
};

async function factsAt(seam: Seam, phase: unknown): Promise<AtCompute> {
  const leaseId = seam.work().picked['leaseId'];
  const [lease] = await rows<{ live: boolean; plan: boolean }>(
    s,
    `select l.state = 'live' as live, r.version_id = $2 as plan
       from public.leases l
       join public.reservations r on r.business_id = l.business_id and r.id = l.reservation_id
      where l.business_id = $1 and l.id = $3`,
    [s.business, seam.planVersionId, leaseId],
  );
  return {
    phase,
    leaseLive: lease?.live === true,
    planLease: lease?.plan === true,
    decisions: await decisionsOn(seam.taskId),
  };
}

/**
 * A runner that, at compute, notes the facts, marks its place in the
 * worker's log, runs `script` on the plan's work and answers its end.
 * `seam` is read late: the runner is made before the worker it is given to.
 */
export function scripted(seam: () => Seam, script: (work: Work) => Promise<StepEnd>): Scripted {
  const computed: AtCompute[] = [];
  return {
    computed,
    runner: {
      compute: async (context: unknown) => {
        const now = seam();
        computed.push(await factsAt(now, (context as { phase?: unknown } | null)?.phase));
        now.log.push({ verb: 'compute', body: {}, status: 0, detail: {} });
        return await script(now.work());
      },
    },
  };
}

/** The verbs the worker sent, in order, with the runner's compute among them. */
export const verbsOf = (seam: Seam): readonly string[] => seam.log.map((sent) => sent.verb);

/** The attempt's step marks: an effect mark or an observation. */
export async function marksOf(work: Work): Promise<{ marked: boolean; observed: boolean }> {
  const [found] = await rows<{ marked: boolean; observed: boolean }>(
    s,
    `select dispatch_marker as marked, observed from public.attempts
      where business_id = $1 and lease_id = $2`,
    [s.business, work.picked['leaseId']],
  );
  return { marked: found?.marked === true, observed: found?.observed === true };
}

let unsentHolds = 0;

/** A call reserved through the real broker and never started: the hold is committed. */
export async function reserveUnsent(work: Work): Promise<string> {
  unsentHolds += 1;
  const operation = { ...REPLAY_COMPOSE, key: `model.replay_unsent_r2_${String(unsentHolds)}` };
  const leaseId = String(work.picked['leaseId']);
  const { attemptId } = await attemptOfLease(s.db.admin, s.business, leaseId);
  const [step] = await rows<{ step_id: string }>(
    s,
    'select step_id::text as step_id from public.attempts where id = $1',
    [attemptId],
  );
  const broker: Broker = {
    ...brokerOver(),
    operations: catalogue([operation]),
    audit: auditAs(s.agentActorId),
  };
  const held = await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await reserveModelCall(
        tx,
        {
          actorId: s.agentActorId,
          delegationId: String(work.picked['delegationId']),
          attendedByPersonId: null,
        },
        {
          leaseId,
          fence: Number(work.picked['fence']),
          stepId: String(step?.step_id),
          operation: operation.key,
          fields: [{ name: 'tone', from: { recordId: work.taskId, key: 'title' } }],
        },
        broker,
      ),
  );
  if (!held.ok) throw new Error(`setup: the unsent hold was refused ${held.code}`);
  return held.reserved.callId;
}
