// SPDX-License-Identifier: AGPL-3.0-only
//
// The worker's composition root and its two jobs: propose one versioned
// synthetic change to the task its delegation is for (T2b), hand the approved
// plan back for review (AW-08), and once a person launches the reviewed
// output, apply it once (T2c2): pick the work up, dispatch the step, write
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
import type { Transport } from '../cli/client.ts';
import { agentCall, type Unanswered } from './agent-call.ts';
import { handedBackFrom, reviewBody, type HandedBack } from './review.ts';
import { callProvider, ProviderFault, type Provider, type UsageReporter } from './usage.ts';

export interface WorkerOptions {
  readonly transport: Transport;
  readonly businessKey: string;
  /** The agent's own login bearer. */
  readonly credential: string;
  /** The one delegation it acts under, from `OPS_ASTRO_DELEGATION` as the command line takes it. */
  readonly delegation: string;
  readonly reporter: UsageReporter;
  /** What the step calls before it acts (T3e1). Absent is the synthetic one, which always answers. */
  readonly provider?: Provider;
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
  /** The plan's work, handed back for review (AW-08, `review.ts`); its launch applies next. */
  | { readonly handedBack: HandedBack }
  /** The provider call dropped after the step was marked, and may have acted; handed back (T3e1). */
  | { readonly dropped: { readonly taskId: string; readonly cause: string } }
  /** Nothing approved and unpicked on the task: done already, or not yet approved. */
  | { readonly idle: { readonly taskId: string } }
  | Unanswered;

/** The effect's text: a note to the team, and nothing leaves the app. */
export const EFFECT_BODY =
  'Synthetic change applied: a team-only comment. This demonstration changes nothing outside the app.';

/** Work this worker picked up and has not yet seen observed: what a later pass resumes. */
interface Held {
  readonly lease: { readonly leaseId: unknown; readonly fence: unknown };
  readonly attemptId: string;
  readonly credential: string;
  /** Set once the provider dropped this attempt: only its hand-back is sent again, and replays. */
  readonly drop?: {
    readonly cause: 'provider_unavailable' | 'connection_lost';
    readonly operationId: string;
  };
  /** Set once the plan's lease went back for review: the hand-back is asked again under it. */
  readonly review?: { readonly operationId: string };
  /** Set once the provider answered: only the comment and observe are sent again, and replay. */
  readonly effected?: {
    readonly link: { readonly receiptLink?: string };
    /** Set once the comment answered: only observe is sent again. */
    readonly commentId?: string;
  };
}

/** Refusals that can clear while a provider answer waits: the client signs off, or no longer must. */
const CLEARS: ReadonlySet<string> = new Set(['CLIENT_SIGNOFF_REQUIRED']);

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
 * and observe each replay; the provider is called once per attempt, and its
 * answer is kept with the work for the comment and observe a resume sends.
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
  const outcome = await effectOnce(options, taskId, work, (next) => {
    kept.set(taskId, next);
  });
  // A fault may be a lost answer, so the work is kept, and so is a provider
  // answer refused for a reason that can clear: the provider may have acted,
  // and a later pass finishes it. Anything else ends it here.
  const now = kept.get(taskId);
  const answered = now !== undefined && 'effected' in now && now.effected !== undefined;
  const waits = answered && 'refused' in outcome && CLEARS.has(outcome.refused.code);
  if (!('fault' in outcome) && !waits) kept.delete(taskId);
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
  held: Held,
  keep: (next: Held) => void,
): Promise<WorkerOutcome> {
  const { lease, attemptId, credential } = held;
  const call = agentCall(options, credential);
  const handBackDrop = async ({ cause, operationId }: NonNullable<Held['drop']>) => {
    const back = await call('task.handback', {
      operationId,
      ...lease,
      outcome: 'dropped',
      report: { dropCause: cause },
    });
    return 'body' in back ? { dropped: { taskId, cause } } : back;
  };
  // A drop whose hand-back answer was lost: send the hand-back again, and
  // never call the provider a second time for this attempt.
  if (held.drop !== undefined) return await handBackDrop(held.drop);
  const handBackForReview = async (operationId: string): Promise<WorkerOutcome> => {
    const maximumMinor = options.reporter.estimate(SYNTHETIC_STEP);
    const back = await call(
      'task.handback',
      reviewBody(lease, operationId, SYNTHETIC_STEP, maximumMinor),
    );
    return 'body' in back ? handedBackFrom(taskId, back.detail) : back;
  };
  if (held.review !== undefined) return await handBackForReview(held.review.operationId);
  const commentAndObserve = async (effected: NonNullable<Held['effected']>) => {
    let commentId = effected.commentId;
    if (commentId === undefined) {
      const effect = await call('task.comment', {
        operationId: effectOperationId(attemptId),
        recordId: taskId,
        body: EFFECT_BODY,
        audience: 'internal',
      });
      if (!('body' in effect)) return effect;
      commentId = String(effect.detail['commentId']);
      keep({ ...held, effected: { ...effected, commentId } });
    }
    const usage = options.reporter.observe(SYNTHETIC_STEP);
    // The link rides as the provider gave it; observe keeps it only on the declared host.
    const observed = await call('task.observe', { ...lease, attemptId, usage, ...effected.link });
    if (!('body' in observed)) return observed;
    return { applied: { taskId, attemptId, commentId } };
  };
  // The provider answered and the comment's or observe's answer was lost: send
  // those again with its answer, and never call the provider a second time.
  // Before the comment, dispatch first, as every pass does: it replays the mark
  // and answers its checks again, so a client sign-off required since refuses
  // the comment. Once the comment applied, only observe is left: it accounts for
  // an effect already made, so no check made since stops it.
  if (held.effected !== undefined) {
    if (held.effected.commentId === undefined) {
      const again = await call('task.dispatch', lease);
      if (!('body' in again)) return again;
    }
    return await commentAndObserve(held.effected);
  }
  // The mark first: a provider call may act and then
  // lose its answer, so it is made only once the step is marked. A fault is
  // then handed back as a drop, and the step's whole hold stays unknown until
  // a person records what happened (T3d1): the register holds only the
  // comment, so the pass cannot prove the provider did nothing.
  // Nothing is released or reserved again on the worker's word.
  const dispatched = await call('task.dispatch', lease);
  // AW-08: a plan's lease fires nothing; refused before any mark, it goes back for review.
  if ('refused' in dispatched && dispatched.refused.code === 'LAUNCH_NOT_DECIDED') {
    const review = { operationId: randomUUID() };
    keep({ ...held, review });
    return await handBackForReview(review.operationId);
  }
  if (!('body' in dispatched)) return dispatched;
  // The provider start is made durable before the call, so a
  // worker lost after it is known to have reached a provider that may have
  // acted, and its missing comment proves nothing. A lost answer here is a
  // fault, and the provider is not called until the start is recorded.
  const starting = await call('task.heartbeat', { ...lease, providerStarting: true });
  if (!('body' in starting)) return starting;
  let link: { readonly receiptLink?: string };
  try {
    link = await callProvider(SYNTHETIC_STEP, options.provider);
  } catch (fault) {
    const cause = fault instanceof ProviderFault ? fault.dropCause : 'connection_lost';
    const drop = { cause, operationId: randomUUID() };
    keep({ ...held, drop });
    // Any other rejection still ends this pass, and the provider may have acted:
    // the next pass hands the drop back and never calls it again.
    if (!(fault instanceof ProviderFault)) throw fault;
    return await handBackDrop(drop);
  }
  keep({ ...held, effected: { link } });
  return await commentAndObserve({ link });
}

export function createWorker(options: WorkerOptions): {
  readonly proposeOnce: () => Promise<WorkerOutcome>;
  readonly applyOnce: (taskId: string) => Promise<WorkerOutcome>;
} {
  const call = agentCall(options, options.delegation);
  const kept = new Map<string, Held | Asked>();
  // A pass on a task already being applied joins that pass: two at once would
  // resume one held attempt twice, and call its provider twice.
  const running = new Map<string, Promise<WorkerOutcome>>();
  return {
    applyOnce: async (taskId) => {
      const pass =
        running.get(taskId) ??
        applyOnce(options, kept, taskId).finally(() => running.delete(taskId));
      running.set(taskId, pass);
      return await pass;
    },
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
