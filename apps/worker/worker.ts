// SPDX-License-Identifier: AGPL-3.0-only
//
// The worker's composition root and its two jobs: propose one versioned
// synthetic change to the task its delegation is for (T2b), and once a person
// approves it, apply it once (T2c2): pick the work up, dispatch the step, write
// the one team-only comment under the operation identity derived from the
// attempt, and observe it. Each step retried after a lost answer presents the
// same identity, so it replays rather than repeats.
//
// It is a client of the API and nothing more (spike RN-04). It talks through
// the command line's own agent entry (`apps/cli/client.ts`), holds an agent
// login and one delegation, and never opens the database: no module it loads
// can, which `tests/worker/worker-boundary.test.ts` checks on its import graph.
// Which task it works on is the delegation's answer, read from
// `session.capabilities`, never chosen here.

import { randomUUID } from 'node:crypto';
import { effectOperationId } from '../../packages/core-wire/src/index.ts';
import { createCli, isRefusal, type CliAnswer, type Transport } from '../cli/client.ts';
import type { UsageReporter } from './usage.ts';

export interface WorkerOptions {
  readonly transport: Transport;
  readonly businessKey: string;
  /** The agent's own login bearer. */
  readonly credential: string;
  /** The one delegation it acts under, from `OPS_ASTRO_DELEGATION` as the command line takes it. */
  readonly delegation: string;
  readonly reporter: UsageReporter;
}

export const SYNTHETIC_STEP = { kind: 'synthetic_comment', payload: {} } as const;

export type WorkerOutcome =
  | {
      readonly proposed: {
        readonly taskId: string;
        readonly version: number;
        readonly gateId: string;
      };
    }
  | {
      readonly applied: {
        readonly taskId: string;
        readonly attemptId: string;
        readonly commentId: string;
      };
    }
  /** Nothing approved and unpicked on the task: done already, or not yet approved. */
  | { readonly idle: { readonly taskId: string } }
  | { readonly refused: { readonly code: string; readonly names: readonly string[] } }
  | { readonly fault: { readonly status: number } };

interface Answered {
  readonly body: Record<string, unknown>;
  readonly detail: Record<string, unknown>;
}

/** The effect's text: a note to the team, and nothing leaves the app. */
export const EFFECT_BODY =
  'Synthetic change applied: a team-only comment. This demonstration changes nothing outside the app.';

type Call = (verb: string, body: object) => Promise<Answered | WorkerOutcome>;

/**
 * One agent call, under `delegation` when there is one. Every call carries an
 * operation id, reads included (`agent-envelope.ts`), and an answer lost in
 * transit is asked for once more under the same id, so it replays.
 */
function agentCall(options: WorkerOptions, delegation?: string): Call {
  const cli = createCli({
    entry: 'agent',
    businessKey: encodeURIComponent(options.businessKey),
    credential: options.credential,
    ...(delegation === undefined ? {} : { delegation }),
    transport: options.transport,
  });
  return async (verb, body) => {
    const sent = { operationId: randomUUID(), ...body };
    return settle(await cli.run(verb, sent).catch(async () => await cli.run(verb, sent)));
  };
}

/** Work this worker picked up and has not yet seen observed: what a later pass resumes. */
interface Held {
  readonly lease: { readonly leaseId: unknown; readonly fence: unknown };
  readonly attemptId: string;
  readonly credential: string;
}

/** A pickup asked for and not yet answered: asked again under its identity, it replays. */
interface Asked {
  readonly reservationId: unknown;
  readonly operationId: string;
}

/**
 * Apply the approved proposal on `taskId` once: pick it up, dispatch, the
 * comment, observe. A pickup leaves the queue whether or not its answer
 * arrives, so a pickup with no answer is kept and asked again under its own
 * identity, which replays it with its credential; work picked up and not yet
 * observed is kept too, and the next pass resumes it. Dispatch, the effect
 * and observe each replay.
 */
async function applyOnce(
  options: WorkerOptions,
  kept: Map<string, Held | Asked>,
  taskId: string,
): Promise<WorkerOutcome> {
  const known = kept.get(taskId);
  let work: Held;
  if (known !== undefined && 'credential' in known) {
    work = known;
  } else {
    const asked = known ?? (await ask(options, taskId));
    if (!('operationId' in asked)) return asked;
    kept.set(taskId, asked);
    const picked = await pickUp(options, asked);
    // A fault may be a lost answer to a committed pickup, so it is asked again.
    if (!('held' in picked)) {
      if (!('fault' in picked)) kept.delete(taskId);
      return picked;
    }
    work = picked.held;
    kept.set(taskId, work);
  }
  const outcome = await effectOnce(options, taskId, work);
  // A fault may be a lost answer, so the work is kept; anything else ends it here.
  if (!('fault' in outcome)) kept.delete(taskId);
  return outcome;
}

/** The queued work on `taskId`, read before any delegation (`agent-envelope.ts`). */
async function ask(options: WorkerOptions, taskId: string): Promise<Asked | WorkerOutcome> {
  const queued = await agentCall(options)('task.queue', {});
  if (!('body' in queued)) return queued;
  const entries = (queued.detail['queue'] ?? []) as readonly Record<string, unknown>[];
  const work = entries.find((entry) => entry['taskId'] === taskId);
  if (work === undefined) return { idle: { taskId } };
  return { reservationId: work['reservationId'], operationId: randomUUID() };
}

/** The pickup, under the identity it was first asked with. */
async function pickUp(
  options: WorkerOptions,
  asked: Asked,
): Promise<{ readonly held: Held } | WorkerOutcome> {
  const picked = await agentCall(options)('task.pickup', asked);
  if (!('body' in picked)) return picked;
  return {
    held: {
      lease: { leaseId: picked.detail['leaseId'], fence: picked.detail['fence'] },
      attemptId: String(picked.detail['attemptId']),
      credential: String(picked.detail['credential']),
    },
  };
}

/** Dispatch, the one comment under the attempt's identity, and its observation. */
async function effectOnce(
  options: WorkerOptions,
  taskId: string,
  { lease, attemptId, credential }: Held,
): Promise<WorkerOutcome> {
  const call = agentCall(options, credential);
  const dispatched = await call('task.dispatch', lease);
  if (!('body' in dispatched)) return dispatched;
  const effect = await call('task.comment', {
    operationId: effectOperationId(attemptId),
    recordId: taskId,
    body: EFFECT_BODY,
    audience: 'internal',
  });
  if (!('body' in effect)) return effect;
  const observed = await call('task.observe', { ...lease, attemptId });
  if (!('body' in observed)) return observed;
  return { applied: { taskId, attemptId, commentId: String(effect.detail['commentId']) } };
}

export function createWorker(options: WorkerOptions): {
  readonly proposeOnce: () => Promise<WorkerOutcome>;
  readonly applyOnce: (taskId: string) => Promise<WorkerOutcome>;
} {
  const call = agentCall(options, options.delegation);
  const kept = new Map<string, Held | Asked>();
  return {
    applyOnce: async (taskId) => await applyOnce(options, kept, taskId),
    proposeOnce: async () => {
      const capabilities = await call('session.capabilities', {});
      if (!('body' in capabilities)) return capabilities;
      const scope = capabilities.body['purposeScope'] as { id?: unknown } | null | undefined;
      const recordId = String(scope?.id ?? '');
      const read = await call('task.read', { recordId });
      if (!('body' in read)) return read;
      const task = read.detail['task'] as { revision?: unknown } | undefined;
      const proposed = await call('task.propose', {
        recordId,
        expectedRevision: task?.revision,
        purpose: SYNTHETIC_STEP.kind,
        maximumMinor: options.reporter.estimate(SYNTHETIC_STEP),
        currency: 'AUD',
        payload: {
          change: 'a team-only comment; this demonstration changes nothing outside the app',
        },
        step: SYNTHETIC_STEP,
      });
      if (!('body' in proposed)) return proposed;
      return {
        proposed: {
          taskId: recordId,
          version: Number(proposed.detail['version']),
          gateId: String(proposed.detail['gateId']),
        },
      };
    },
  };
}

/** A success's body, or the outcome that ends this attempt. No credential is ever in either. */
function settle(answer: CliAnswer): Answered | WorkerOutcome {
  const body = answer.body as Record<string, unknown> | undefined;
  if (answer.status >= 200 && answer.status < 300 && body !== undefined) {
    return { body, detail: (body['detail'] as Record<string, unknown> | undefined) ?? {} };
  }
  if (isRefusal(answer)) {
    const refusal = body as { code: string; names?: readonly string[] };
    return { refused: { code: refusal.code, names: refusal.names ?? [] } };
  }
  return { fault: { status: answer.status } };
}
