// SPDX-License-Identifier: AGPL-3.0-only
//
// T2b in the worker: the one versioned synthetic change it proposes on the
// task its delegation is for, and the agent identity it proposes as. A
// proposal sent with no answer may have committed, so it is kept and sent
// again under its own operation id, which replays it rather than opening a
// second lineage and gate. That id comes from the work itself (#778), so a
// second worker on the same delegation, or a restarted one, names the same
// operation. A worker that restarted knows nothing it sent: it looks in the
// queue first for its own approved proposal (#786). Like the rest of the
// worker, this only shapes calls to the API.

import { createHash } from 'node:crypto';
import type { Answered, Call, Unanswered } from './agent-call.ts';
import type { UsageReporter } from './usage.ts';

/** What one worker knows of its own proposing: who it is, and a proposal not yet answered. */
export interface Proposer {
  actorId?: string;
  unanswered?: { readonly recordId: string; readonly [field: string]: unknown } | undefined;
  /** The proposal pass under way: a second pass shares it, never starting its own. */
  running?: Promise<Proposed> | undefined;
  /** Refusals the server settled on this work: each names the next proposal's operation anew. */
  refusals?: number;
}

export type Proposed =
  | {
      readonly proposed: {
        readonly taskId: string;
        readonly version: number;
        readonly gateId: string;
      };
    }
  /** Its own proposal, approved and in the queue: the next pass applies it. */
  | { readonly queued: { readonly taskId: string } }
  | Unanswered;

/** This agent's own proposal of the step in the queue on `taskId`, if it waits there. */
export type Queued = (
  taskId: string,
) => Promise<{ readonly reservationId: unknown } | { readonly idle: unknown } | Unanswered>;

/** The agent's own acting identity, read from its capabilities once and kept. */
export async function selfOf(call: Call, mine: Proposer): Promise<string | Unanswered> {
  if (mine.actorId !== undefined) return mine.actorId;
  const capabilities = await call('session.capabilities', {});
  if (!('body' in capabilities)) return capabilities;
  mine.actorId = String(capabilities.body['agentActorId']);
  return mine.actorId;
}

/** The task the delegation names, read under it now: a revoked one answers its refusal. */
export async function delegatedTask(call: Call): Promise<string | Unanswered> {
  const capabilities = await call('session.capabilities', {});
  if (!('body' in capabilities)) return capabilities;
  const scope = capabilities.body['purposeScope'] as { id?: unknown } | null | undefined;
  return typeof scope?.id === 'string' ? scope.id : '';
}

/** `step` proposed once on the delegation's task, one pass at a time per worker. */
export async function proposeStep(
  call: Call,
  mine: Proposer,
  step: { readonly kind: string },
  reporter: Pick<UsageReporter, 'estimate' | 'compute'>,
  queued: Queued,
): Promise<Proposed> {
  mine.running ??= proposeAlone(call, mine, step, reporter, queued).finally(() => {
    mine.running = undefined;
  });
  return await mine.running;
}

/**
 * Whether the task shows the proposal `operationId` names: its payload
 * carries that id, so the server's own read tells a committed proposal from
 * one that never ran. A replay refused by a delegation check
 * (`agent-replay.ts`) may be withholding a committed receipt; it is kept
 * unless this read answers and shows no such proposal.
 */
async function committed(call: Call, recordId: string, operationId: string): Promise<boolean> {
  const read = await call('task.read', { recordId });
  if (!('body' in read)) return true;
  const task = read.detail['task'] as { proposals?: readonly LineageSeen[] } | undefined;
  return (task?.proposals ?? []).some((lineage) =>
    (lineage.versions ?? []).some((one) => one.payload?.proposalId === operationId),
  );
}

interface LineageSeen {
  readonly versions?: readonly { readonly payload?: { readonly proposalId?: unknown } }[];
}

/**
 * One proposal's operation identity, from the work it proposes: the agent, the
 * task, the revision it read, the step, and how many of its proposals the
 * server refused. Every worker and every retry on the same work names the same
 * operation, so the register replays the first; a refusal, which the register
 * keeps too, moves the next to a new one (S2090-3), and a restarted worker
 * walks the refusals it replays to the same place.
 */
const proposalIdentity = (mine: Proposer, taskId: string, revision: unknown, kind: string) =>
  `proposal:${createHash('sha256')
    .update(
      `${String(mine.actorId)}:${taskId}:${String(revision)}:${kind}:${String(mine.refusals ?? 0)}`,
    )
    .digest('hex')}`;

/** A proposal with no answer, or one whose refusal proves nothing, is sent again as it was. */
async function proposeAlone(
  call: Call,
  mine: Proposer,
  step: { readonly kind: string },
  reporter: Pick<UsageReporter, 'estimate' | 'compute'>,
  queued: Queued,
): Promise<Proposed> {
  const capabilities = await call('session.capabilities', {});
  if (!('body' in capabilities)) return capabilities;
  mine.actorId = String(capabilities.body['agentActorId']);
  if (mine.unanswered === undefined) {
    const scope = capabilities.body['purposeScope'] as { id?: unknown } | null | undefined;
    const recordId = String(scope?.id ?? '');
    const own = await queued(recordId);
    // A queue the agent may not read yet tells nothing: the proposal goes on as before.
    if ('reservationId' in own) return { queued: { taskId: recordId } };
    if ('fault' in own) return own;
    const read = await call('task.read', { recordId });
    if (!('body' in read)) return read;
    const task = read.detail['task'] as { revision?: unknown } | undefined;
    const operationId = proposalIdentity(mine, recordId, task?.revision, step.kind);
    mine.unanswered = {
      operationId,
      recordId,
      expectedRevision: task?.revision,
      purpose: step.kind,
      maximumMinor: reporter.estimate(step) + (reporter.compute ?? 0),
      currency: 'AUD',
      payload: {
        change: 'a team-only comment; this demonstration changes nothing outside the app',
        proposalId: operationId,
      },
      step,
    };
  }
  const sent = mine.unanswered;
  const proposed = await call('task.propose', sent);
  if ('fault' in proposed) return proposed;
  const withheld = 'refused' in proposed && proposed.refused.code.startsWith('DELEGATION_');
  if (withheld && (await committed(call, sent.recordId, String(sent['operationId'])))) {
    return proposed;
  }
  mine.unanswered = undefined;
  if ('refused' in proposed) mine.refusals = (mine.refusals ?? 0) + 1;
  return answered(sent.recordId, proposed);
}

/** A proposal the server settled: its gate, or its refusal. */
function answered(taskId: string, proposed: Answered | Unanswered): Proposed {
  if (!('body' in proposed)) return proposed;
  return {
    proposed: {
      taskId,
      version: Number(proposed.detail['version']),
      gateId: String(proposed.detail['gateId']),
    },
  };
}
