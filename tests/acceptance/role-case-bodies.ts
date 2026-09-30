// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control: the minimal valid body each declaration needs.
//
// It is its own file for T1h's reason, which is the same reason the harness is
// its own file: about 400 lines is the guide for a readable file, and the
// repository's answer is to split the file rather than the change or the
// comments. The seam is a real one — this is the only part of the
// matrix that knows what a *task* is, as opposed to what a caller is — so
// `role-case-harness.ts` stays about identity and the ledger and this stays
// about the domain.
//
// **Why the positive control is the whole matrix.** Nine refusals prove
// nothing if the same request would have been refused anyway: for its shape,
// for a missing revision, for a record that was never there. So every recipe
// below is the smallest body that leaves nothing but authority between the
// caller and a 200, with whatever has to exist first brought into existence
// first — a task to complete before one can be reopened, a trash batch before
// a restore, a proposal before a decision.
//
// **A declaration with no recipe fails.** The switch is exhaustive over
// `CommandName` and its default throws. That is what keeps the generation
// honest: an operation added to the surface cannot be skipped here quietly,
// because being skipped is a thrown error rather than an absent row.

import { effectOperationId, type CommandName } from '../../packages/core-wire/src/surface.ts';
import type { Answer } from './world.ts';

/**
 * The proposal every case that needs a gate proposes, spelled once. Its step is
 * the worker's replayable synthetic one, so the work it approves can be
 * dispatched (T2c1); a kind declaring no reconcile mode is refused there.
 */
export const PROPOSAL = {
  purpose: 'draft_the_reply',
  maximumMinor: 3_000,
  currency: 'AUD',
  payload: { instruction: 'draft a reply' },
  step: { kind: 'synthetic_comment', payload: {} },
} as const;

/** A proposal on `task`, answering with the lineage it opened. */
export async function lineageOn(context: BodyContext, task: Task): Promise<string> {
  const proposed = await context.asPerson('task.propose', {
    recordId: task.id,
    expectedRevision: task.revision,
    ...PROPOSAL,
  });
  if (proposed.code !== 'ok') throw new Error(`matrix: propose refused ${proposed.code}`);
  return String((proposed.body['detail'] as Record<string, unknown>)['lineageId']);
}

/** A body the case can send, or the reason there is no such body. */
export type Prepared = { readonly body: Record<string, unknown> } | { readonly exception: string };

export interface Task {
  readonly id: string;
  readonly revision: number;
}

/** What a recipe needs from the world, and nothing else. */
export interface BodyContext {
  /** The task every case can name, for the reads that only need one. */
  readonly alphaTaskId: string;
  /** A person of this business, for the one field that must name one. */
  readonly assigneePersonId: string;
  asPerson(name: CommandName, body: Readonly<Record<string, unknown>>): Promise<Answer>;
  /** The agent's own prefix, where a harness has one (`stopped-run.ts`). */
  asAgent?(
    name: CommandName,
    body: Readonly<Record<string, unknown>>,
    credential?: string,
  ): Promise<Answer>;
  freshTask(title: string): Promise<Task>;
}

export const batchOf = (answer: Answer): string =>
  String((answer.body['detail'] as Record<string, unknown>)['batchId']);

/** A proposal a person may decide on, which is what `task.decide` needs to exist. */
export async function approvableGate(
  context: BodyContext,
): Promise<{ gateId: string; versionId: string }> {
  const task = await context.freshTask('a task with a proposal on it');
  const proposed = await context.asPerson('task.propose', {
    recordId: task.id,
    expectedRevision: task.revision,
    ...PROPOSAL,
  });
  if (proposed.code !== 'ok') throw new Error(`matrix: propose refused ${proposed.code}`);
  const detail = proposed.body['detail'] as Record<string, string>;
  return { gateId: detail['gateId'] as string, versionId: detail['versionId'] as string };
}

/** Proposed and approved by the context's person: a reservation on the queue. */
export async function approvedReservationId(context: BodyContext): Promise<string> {
  const gate = await approvableGate(context);
  const decided = await context.asPerson('task.decide', {
    ...gate,
    decision: 'approve',
    note: 'approved so a person can work it',
  });
  if (decided.code !== 'ok') throw new Error(`matrix: decide refused ${decided.code}`);
  return String((decided.body['detail'] as Record<string, unknown>)['reservationId']);
}

/** A task whose plan the context's person approved: an envelope to top up (T2e). */
export async function approvedTaskId(context: BodyContext): Promise<string> {
  const task = await context.freshTask('a task whose envelope is topped up');
  const proposed = await context.asPerson('task.propose', {
    recordId: task.id,
    expectedRevision: task.revision,
    ...PROPOSAL,
  });
  if (proposed.code !== 'ok') throw new Error(`matrix: propose refused ${proposed.code}`);
  const detail = proposed.body['detail'] as Record<string, string>;
  const decided = await context.asPerson('task.decide', {
    gateId: detail['gateId'],
    versionId: detail['versionId'],
    decision: 'approve',
    note: 'approved so its envelope can be topped up',
  });
  if (decided.code !== 'ok') throw new Error(`matrix: decide refused ${decided.code}`);
  return task.id;
}

/** The context's person's own pickup of fresh approved work (EX-01), as its answer's detail. */
async function ownPickup(context: BodyContext): Promise<Record<string, unknown>> {
  const picked = await context.asPerson('task.pickup', {
    reservationId: await approvedReservationId(context),
  });
  if (picked.code !== 'ok') throw new Error(`matrix: person pickup refused ${picked.code}`);
  return picked.body['detail'] as Record<string, unknown>;
}

/** A lease the context's person holds: their own pickup of fresh approved work (EX-01). */
export async function ownLease(context: BodyContext): Promise<{ leaseId: string; fence: number }> {
  const detail = await ownPickup(context);
  return { leaseId: String(detail['leaseId']), fence: Number(detail['fence']) };
}

/**
 * The person's own lease with its step dispatched and its one effect applied
 * under the attempt's operation identity (T2c2): what `task.observe` takes.
 */
export async function ownAppliedEffect(
  context: BodyContext,
): Promise<{ leaseId: string; fence: number; attemptId: string }> {
  const { taskId: _taskId, ...applied } = await ownAppliedOnTask(context);
  return applied;
}

/** `ownAppliedEffect`, with the task it applied on (T3d1). */
async function ownAppliedOnTask(
  context: BodyContext,
): Promise<{ leaseId: string; fence: number; attemptId: string; taskId: string }> {
  const detail = await ownPickup(context);
  const lease = { leaseId: String(detail['leaseId']), fence: Number(detail['fence']) };
  const attemptId = String(detail['attemptId']);
  const taskId = String(detail['taskId']);
  const marked = await context.asPerson('task.dispatch', lease);
  if (marked.code !== 'ok') throw new Error(`matrix: dispatch refused ${marked.code}`);
  const read = await context.asPerson('task.read', { recordId: taskId });
  const effect = await context.asPerson('task.comment', {
    operationId: effectOperationId(attemptId),
    recordId: taskId,
    expectedRevision: (read.body['task'] as { revision: number }).revision,
    body: 'the synthetic effect',
    audience: 'internal',
  });
  if (effect.code !== 'ok') throw new Error(`matrix: effect refused ${effect.code}`);
  return { ...lease, attemptId, taskId };
}

/**
 * An attempt of the person's own held as an unknown liability (T2d): its effect
 * applied, then observed at a cost above the hold. What a recorded outcome
 * takes (T3d1).
 */
export async function ownUnknownAttempt(context: BodyContext): Promise<Record<string, unknown>> {
  const { taskId, ...applied } = await ownAppliedOnTask(context);
  const observed = await context.asPerson('task.observe', {
    ...applied,
    usage: { item: 'synthetic_comment_long', quantity: 1 },
  });
  // T2d answers a cost above the hold BUDGET_UNAVAILABLE and keeps the
  // attempt held unknown (the refusal retains its writes).
  if (observed.code !== 'BUDGET_UNAVAILABLE') {
    throw new Error(`matrix: observe answered ${observed.code}, not the unknown hold`);
  }
  return { recordId: taskId, attemptId: applied.attemptId };
}
