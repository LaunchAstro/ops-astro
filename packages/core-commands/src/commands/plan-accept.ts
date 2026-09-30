// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.accept_plan`: a person's one click on the plan's gate (AW-04).
//
// Everything the body carries is checked before any row is written: the
// words and the structured plan record (`boundPlanOf`), the instruction paths'
// shape, and the origin conversation, which is the caller's own or
// `NOT_FOUND`. The files are read from the server's instruction root, never
// from the body; a deployment with none configured cannot accept. Then
// `acceptPlan` approves, pins and binds in this one transaction. The authority
// was asked on the gate's own task by the surface (`task.decide`'s lookup),
// and `decide` asks it again under its locks.

import { subjectsOf } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import {
  acceptPlan,
  boundPlanOf,
  configuredInstructionSource,
  INSTRUCTION_ROOT_VARIABLE,
  type BoundPlan,
  type PlanAccepted,
} from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';
import { decisionKeys, GATE_NOT_VISIBLE } from './tasks-decide.ts';
import { originOf } from './tasks-write.ts';

export interface AcceptFields {
  readonly gateId: string;
  /** The plan version shown beside the button. Compared under the locks, never trusted. */
  readonly versionId: string;
  readonly note: string;
  readonly planText: unknown;
  readonly plan: unknown;
  readonly entryPath: unknown;
  readonly paths: unknown;
  readonly conversationId?: string | null;
}

const PATH_LIMIT = 50;

const invalid = (field: string, reason: string): HandlerOutcome =>
  refused(refuseCommand('FIELD_VALUE_INVALID', [field], [reason]));

const isPathList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) &&
  value.length <= PATH_LIMIT &&
  value.every((path) => typeof path === 'string');

/** The body's plan and paths, checked by value, or the refusal naming the first bad field. */
function checked(
  fields: AcceptFields,
):
  | { readonly plan: BoundPlan; readonly entryPath: string; readonly paths: readonly string[] }
  | HandlerOutcome {
  const plan = boundPlanOf(fields.planText, fields.plan);
  if ('field' in plan) return invalid(plan.field, plan.reason);
  if (typeof fields.entryPath !== 'string') {
    return invalid('entryPath', 'Name the bootstrap file as a relative path.');
  }
  if (!isPathList(fields.paths)) {
    return invalid('paths', `Name up to ${String(PATH_LIMIT)} other files as relative paths.`);
  }
  return { plan, entryPath: fields.entryPath, paths: fields.paths };
}

const NO_ROOT: HandlerOutcome = refused(
  refuseCommand(
    'DEPENDENCY_NOT_LANDED',
    ['task.accept_plan', INSTRUCTION_ROOT_VARIABLE],
    [
      'This deployment has no instruction root configured, so no run can be activated.',
      'It is not a permission problem and retrying will not change it.',
    ],
  ),
);

/** The approval's detail, with what the accept pinned and bound. */
function acceptedOutcome(accepted: PlanAccepted, plan: BoundPlan): HandlerOutcome {
  return applied(null, null, {
    decisionId: accepted.decisionId,
    gateId: accepted.gateId,
    versionId: accepted.versionId,
    decision: accepted.decision,
    hash: accepted.hash,
    envelopeId: accepted.envelopeId,
    reservationId: accepted.reservationId,
    attemptId: accepted.attemptId,
    heldMinor: accepted.heldMinor,
    runId: accepted.runId,
    pin: accepted.pin,
    manifestDigest: accepted.manifestDigest,
    planRecordId: accepted.planRecordId,
    textDigest: plan.textDigest,
    recordDigest: plan.recordDigest,
  });
}

export async function acceptPlanOnGate(
  tx: TenantQuery,
  context: CommandContext,
  fields: AcceptFields,
): Promise<HandlerOutcome> {
  const body = checked(fields);
  if (!('plan' in body)) return body;
  const origin = await originOf(tx, context, fields.conversationId);
  if (origin !== undefined && typeof origin !== 'string') return origin;
  const source = configuredInstructionSource();
  if (source === undefined) return NO_ROOT;
  const keys = await decisionKeys(tx, fields.gateId);
  if (!('signingKey' in keys)) return keys;

  const result = await acceptPlan(
    tx,
    {
      gateId: fields.gateId,
      versionId: fields.versionId,
      decidedByPersonId: context.session.personId,
      decidedByActorId: context.session.actorId,
      subjects: subjectsOf(context.session),
      collection: context.declaration.collection,
      note: fields.note,
      ...keys,
      ...body,
      originConversationId: origin ?? null,
    },
    source,
  );
  if (!result.ok) {
    return refused(result.refusal.code === 'GATE_NOT_FOUND' ? GATE_NOT_VISIBLE : result.refusal);
  }
  const outcome = acceptedOutcome(result.value, body.plan);
  return origin === undefined ? outcome : { ...outcome, originConversationId: origin };
}
