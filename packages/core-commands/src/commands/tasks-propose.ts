// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.propose`: a proposal on a task, through the runtime's locks.

import {
  checkAuthority,
  checkDelegatedAuthority,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type { Delegation, Subject, TenantQuery } from '../../../core-records/src/index.ts';
import { lockProposal, proposeUnderLocks } from '../../../core-runtime/src/index.ts';
import type { CommandContext, TaskRow } from './context.ts';
import { lockTask, REVISION_FIXES } from './prepare.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { EXPIRY_FIX, expiryFrom } from './expiry.ts';
import { invalid, isFieldMap } from './operands.ts';
import { readBusinessCapId } from '../../../core-runtime/src/index.ts';

export interface ProposeFields {
  readonly purpose: string;
  readonly maximumMinor: number;
  readonly currency: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly step: { readonly kind: string; readonly payload: Readonly<Record<string, unknown>> };
  readonly expiresInSeconds?: number;
  readonly lineageId?: string;
  /** The task revision the caller read, compared under the runtime's locks. */
  readonly expectedRevision?: number;
}

/**
 * The shape `proposal_versions_purpose_shape` and `delegations_purpose_shape`
 * both hold (`migrations/0010_runtime_proposals.sql:122`). Kept here as the
 * same expression so the refusal and the constraint cannot drift apart.
 */
const PURPOSE_SHAPE = /^[a-z][a-z0-9_]{0,62}$/u;

/**
 * `planned_steps.kind` is `not null` and `payload` is `jsonb not null`. The
 * payload is a JSON object, not an array: spreading an array or a string into
 * one stores bytes the proposer never sent.
 */
function isStep(
  step: unknown,
): step is { readonly kind: string; readonly payload: Readonly<Record<string, unknown>> } {
  if (typeof step !== 'object' || step === null) return false;
  const candidate = step as { kind?: unknown; payload?: unknown };
  if (typeof candidate.kind !== 'string' || candidate.kind === '') return false;
  return isFieldMap(candidate.payload);
}

/**
 * A proposal on the locked task.
 *
 * The expiry is named as a duration and turned into an instant **here**,
 * rather than taken as a date from the body. A caller who could post an
 * absolute `expiresAt` could post one in the past and raise a gate nobody can
 * decide; a duration the server adds to its own clock cannot. `expiryFrom`
 * bounds the duration at `MAXIMUM_EXPIRY_SECONDS`, seven days (owner decision,
 * 23 Sep 2026). Over it is `FIELD_VALUE_INVALID`, and no gate is written.
 */
export async function proposeOnTask(
  tx: TenantQuery,
  context: CommandContext,
  fields: ProposeFields,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('proposeOnTask: reached without a task');
  return await proposeFor(
    tx,
    {
      target,
      collection: context.declaration.collection,
      taskTypeId: context.spine.taskTypeId,
      actorId: context.session.actorId,
      subjects: subjectsOf(context.session),
    },
    fields,
  );
}

/**
 * Who proposes, on which locked task. A person proposes as themselves; an
 * agent proposes as its own actor, and the runtime's authority check under the
 * locks asks the delegating person's grants, which are the ceiling its
 * delegation narrows (`agent-operations.ts`, T2b).
 */
export interface Proposer {
  readonly target: TaskRow;
  readonly collection: string;
  readonly taskTypeId: string;
  readonly actorId: string;
  readonly subjects: readonly Subject[];
  /** An agent's: its reach is the delegation's, inside the person's grants. */
  readonly delegation?: Delegation;
}

export async function proposeFor(
  tx: TenantQuery,
  { target, collection, taskTypeId, actorId, subjects, delegation }: Proposer,
  fields: ProposeFields,
): Promise<HandlerOutcome> {
  // A trashed task is gone to the work surface until its batch is restored,
  // so a proposal on it answers as one on a task that is not there, before
  // any operand and before the revision (`task.restart` in
  // `tasks-controls.ts`, RUNTIME.md). Checked again under
  // the lock below, for a trash that commits in between.
  if (target.deleted_at !== null) return refused(refuseNotFound());
  // Two shapes the columns constrain, answered here rather than left to the
  // constraint. `proposal_versions_purpose_shape` and `planned_steps.kind not
  // null` both fault at the write, and a fault reaches the caller as
  // `SERVICE_UNAVAILABLE` 503 -- a malformed request shown as a broken server,
  // which is the difference checklist B7 asks to be real.
  // `FIELD_VALUE_INVALID` 422 is already
  // on this operation's row in `docs/local/API.md`.
  //
  // Each operand's type is checked before its shape, because the body is the
  // caller's JSON and not `ProposeFields`: `RegExp.prototype.test` coerces
  // `undefined`, `null` and `true` to strings the pattern matches, and each
  // would then fault at the bound parameter.
  if (typeof fields.purpose !== 'string' || !PURPOSE_SHAPE.test(fields.purpose)) {
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
  const currency: unknown = fields.currency;
  if (typeof currency !== 'string' || currency === '') {
    return refused(invalid('currency', 'Name the currency the ceiling is in, such as AUD.'), {
      currency,
    });
  }
  // Absent opens a new lineage; present and not a string is the body's shape,
  // answered as `task.cancel` answers it (`tasks-controls.ts`).
  const lineageId: unknown = fields.lineageId;
  if (lineageId !== undefined && lineageId !== null && typeof lineageId !== 'string') {
    return refused(
      refuseCommand(
        'COMMAND_BODY_INVALID',
        ['lineageId'],
        ['Name the lineage by its id, or leave it out to open a new one.'],
      ),
    );
  }
  // Spread into an object, a string or an array would become an index-keyed
  // object, and absent would become `{}`, so the approver would sign over a
  // payload the proposer never sent.
  if (!isFieldMap(fields.payload)) {
    return refused(invalid('payload', 'Send the payload as a JSON object.'));
  }
  if (!isStep(fields.step)) {
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['step'],
        ['Send a step as { kind, payload }, with a non-empty kind and a JSON object payload.'],
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
    collection,
    proposedByActorId: actorId,
    subjects,
    purpose: fields.purpose,
    maximumMinor: fields.maximumMinor,
    currency: fields.currency,
    payload: { ...fields.payload },
    step: { kind: fields.step.kind, payload: { ...fields.step.payload } },
    expiresAt,
    ...(typeof lineageId === 'string' ? { lineageId } : {}),
    // T1's existing budget authority, for a task with no envelope open yet:
    // the cap the decision would draw on.
    ...(await readBusinessCapId(tx).then((capId) => (capId === undefined ? {} : { capId }))),
  };
  // The runtime takes cap, envelope, task and the rest in the contract's
  // order; the envelope only read the task (`targetLock: 'runtime'`). The
  // revision is compared here, with the task lock already held in that order,
  // so a concurrent write is still refused `VERSION_STALE` and never merged.
  const held = await lockProposal(tx, proposal);
  const current = await lockTask(tx, taskTypeId, target.id);
  if (current === undefined || current.deleted_at !== null) {
    return refused(refuseNotFound());
  }
  const research = current.data['type'] === 'research';
  // WF-7 claim first (ORCH36 ruling P): the starter is the person the
  // proposal is asked as, an agent's delegating person included. Asked
  // before the revision, so a starter who lost the race is told it is claimed.
  const starter = subjects.find((subject) => subject.kind === 'person')?.id ?? actorId;
  if (research) {
    const refusal = await researchRunRefusal(tx, target.id, subjects, delegation);
    if (refusal !== undefined) return refused(refusal);
    if (claimedByAnother(current, starter)) {
      return refused(refuseCommand('TRANSITION_NOT_PERMITTED', ['claimed'], [CLAIMED_FIX]));
    }
  }
  if (fields.expectedRevision !== current.revision) {
    return refused(
      refuseCommand('VERSION_STALE', [`revision=${current.revision}`], REVISION_FIXES),
    );
  }
  const result = await proposeUnderLocks(tx, proposal, held);
  if (!result.ok) return refused(result.refusal);
  const revision =
    research && !isSet(current.data['assignee'])
      ? await claimFor(tx, target.id, starter)
      : current.revision;

  // The revision is the task's own and is unchanged: a proposal is a record
  // beside the task, not an edit to it, so a caller may keep writing against
  // the revision they hold. `task.comment` answers the same way. The one
  // exception is a research run's claim above, which writes the ticket.
  return applied(target.id, revision, {
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

/**
 * WF-7: Run on a research ticket starts a research run, which is `run:write`
 * on the ticket beside the row's `task:write`. An agent reaches it only where
 * its delegation does (MP-6-2 mints `run` for a person holding it), and never
 * past its person's grants. Asked under the task lock, as the runtime asks.
 */
async function researchRunRefusal(
  tx: TenantQuery,
  taskId: string,
  subjects: readonly Subject[],
  delegation: Delegation | undefined,
): Promise<CommandRefusal | undefined> {
  const request = {
    collection: 'run',
    action: 'write',
    scope: { kind: 'record', id: taskId },
  } as const;
  if (delegation !== undefined) {
    const reach = await checkDelegatedAuthority(tx, delegation, request);
    if (!reach.ok) return reach.refusal;
  }
  if ((await checkAuthority(tx, subjects, request)).ok) return undefined;
  return refuseCommand('SCOPE_NOT_GRANTED', ['run:write'], [RUN_WRITE_FIX]);
}

const RUN_WRITE_FIX = 'Starting a research run needs run:write on the ticket; ask for it.';
const CLAIMED_FIX = 'Someone else has claimed this ticket; its run is theirs to start.';

const isSet = (value: unknown): boolean => value !== undefined && value !== null;

/** Held by a person other than the starter, or by an agent. */
function claimedByAnother(ticket: TaskRow, starter: string): boolean {
  const assignee = ticket.data['assignee'];
  return (isSet(assignee) && assignee !== starter) || isSet(ticket.data['delegate']);
}

/** The claim `task.claim` writes, in the proposal's transaction under its lock. */
async function claimFor(tx: TenantQuery, taskId: string, starter: string): Promise<number> {
  const rows = await tx.query<{ readonly revision: string }>(
    `update records set data = data || jsonb_build_object('assignee', $3::uuid), updated_at = now()
      where business_id = $1 and id = $2 returning revision::text as revision`,
    [tx.businessId, taskId, starter],
  );
  return Number(rows[0]?.revision);
}
