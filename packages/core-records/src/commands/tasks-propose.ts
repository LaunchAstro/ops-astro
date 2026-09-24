// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.propose`: a proposal on a task, through the runtime's locks. Moved out of
// `tasks-runtime.ts` unchanged (thermo review b282216, H2).

import type { TenantQuery } from '../tenancy/database.ts';
import { subjectsOf } from '../authority/grants.ts';
import { lockProposal, proposeUnderLocks } from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { lockTask, REVISION_FIXES } from './prepare.ts';
import { fromReasoned, refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { EXPIRY_FIX, expiryFrom } from './expiry.ts';

export interface ProposeFields {
  readonly purpose: string;
  readonly maximumMinor: number;
  readonly currency: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly step: { readonly kind: string; readonly payload: Readonly<Record<string, unknown>> };
  readonly expiresInSeconds?: number;
  readonly lineageId?: string;
  /** The task revision the caller read, compared under the runtime's locks (F1). */
  readonly expectedRevision?: number;
}

/**
 * The shape `proposal_versions_purpose_shape` and `delegations_purpose_shape`
 * both hold (`migrations/0010_runtime_proposals.sql:122`). Kept here as the
 * same expression so the refusal and the constraint cannot drift apart.
 */
const PURPOSE_SHAPE = /^[a-z][a-z0-9_]{0,62}$/u;

/** `planned_steps.kind` is `not null` and `payload` is `jsonb not null`. */
function isStep(step: unknown): step is { readonly kind: string; readonly payload: object } {
  if (typeof step !== 'object' || step === null) return false;
  const candidate = step as { kind?: unknown; payload?: unknown };
  if (typeof candidate.kind !== 'string' || candidate.kind === '') return false;
  return typeof candidate.payload === 'object' && candidate.payload !== null;
}

/**
 * A proposal on the locked task.
 *
 * The expiry is named as a duration and turned into an instant **here**,
 * rather than taken as a date from the body. A caller who could post an
 * absolute `expiresAt` could post one in the past and raise a gate nobody can
 * decide; a duration the server adds to its own clock cannot. There is no
 * upper bound on the duration yet, so a very long one still holds a gate open
 * for as long as it names.
 */
export async function proposeOnTask(
  tx: TenantQuery,
  context: CommandContext,
  fields: ProposeFields,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('proposeOnTask: reached without a task');
  // Two shapes the columns constrain, answered here rather than left to the
  // constraint. `proposal_versions_purpose_shape` and `planned_steps.kind not
  // null` both fault at the write, and a fault reaches the caller as
  // `SERVICE_UNAVAILABLE` 503 -- a malformed request shown as a broken server,
  // which is the difference checklist B7 asks to be real (WEB-PROPOSALS
  // handback, "Interface gaps for L3" 4). `FIELD_VALUE_INVALID` 422 is already
  // on this operation's row in `docs/local/API.md`.
  if (!PURPOSE_SHAPE.test(fields.purpose)) {
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['purpose'],
        [
          'A purpose is lower-case letters, digits and underscores, starting with a letter, up to 63 characters.',
        ],
      ),
      { purpose: fields.purpose },
    );
  }
  if (!isStep(fields.step)) {
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['step'],
        ['Send a step as { kind, payload }, with a non-empty kind and an object payload.'],
      ),
      { step: fields.step },
    );
  }

  const expiresAt = expiryFrom(fields.expiresInSeconds);
  if (expiresAt === undefined) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['expiresInSeconds'], [EXPIRY_FIX]), {
      expiresInSeconds: fields.expiresInSeconds,
    });
  }

  const proposal = {
    taskId: target.id,
    collection: context.declaration.collection,
    proposedByActorId: context.session.actorId,
    subjects: subjectsOf(context.session),
    purpose: fields.purpose,
    maximumMinor: fields.maximumMinor,
    currency: fields.currency,
    payload: { ...fields.payload },
    step: { kind: fields.step.kind, payload: { ...fields.step.payload } },
    expiresAt,
    ...(fields.lineageId === undefined ? {} : { lineageId: fields.lineageId }),
  };
  // F1. The runtime takes cap, envelope, task and the rest in the contract's
  // order; the envelope only read the task (`targetLock: 'runtime'`). The
  // revision is compared here, with the task lock already held in that order,
  // so a concurrent write is still refused `VERSION_STALE` and never merged.
  const held = await lockProposal(tx, proposal);
  const current = await lockTask(tx, context.spine.taskTypeId, target.id);
  if (current === undefined) {
    return refused(refuseCommand('NOT_FOUND', [], ['Check the identifier you were given.']));
  }
  if (fields.expectedRevision !== current.revision) {
    return refused(
      refuseCommand('VERSION_STALE', [`revision=${current.revision}`], REVISION_FIXES),
    );
  }
  const result = await proposeUnderLocks(tx, proposal, held);
  if (!result.ok) return refused(fromReasoned(result.refusal));

  // The revision is the task's own and is unchanged: a proposal is a record
  // beside the task, not an edit to it, so a caller may keep writing against
  // the revision they hold. `task.comment` answers the same way.
  return applied(target.id, current.revision, {
    lineageId: result.value.lineageId,
    versionId: result.value.versionId,
    version: result.value.version,
    runId: result.value.runId,
    stepId: result.value.stepId,
    evidencePackId: result.value.evidencePackId,
    gateId: result.value.gateId,
    payloadDigest: result.value.payloadDigest,
  });
}
