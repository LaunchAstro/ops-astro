// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's two commands: `live correction requested` and `live correction
// approved` (the permissions table of #765).
//
// The request is checked against the envelope before anything is written, so
// a change of more than one word on one line of one file is refused with
// nothing stored; what is stored is the target, the digests and the version
// the approval must name, never the file's text. The approval locks the row at
// its party, reads the configured approver under a share lock on its setting,
// and refuses the requester first: a person cannot approve their own change
// even when they are the configured approver (release decision 3.4).
//
// Refusals carry fixed text only: no word, path, page or content of the
// correction reaches a caller who is refused.

import { randomUUID } from 'node:crypto';
import {
  checkAuthority,
  GATE_COLLECTION,
  insertLiveCorrection,
  RUN_COLLECTION,
  isActiveMember,
  lockConfiguredApprover,
  lockCoveredCorrection,
  subjectsOf,
  writeCorrectionDecision,
} from '../../../core-records/src/index.ts';
import type { Delegation, TenantQuery } from '../../../core-records/src/index.ts';
import { checkEnvelope, contentDigest } from '../../../core-connectors/src/index.ts';
import { readTaskSpine, type CommandContext } from './context.ts';
import type { CommandRequest } from './requests.ts';
import { refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';

type Of<K extends CommandRequest['command']> = CommandRequest & { readonly command: K };

const ENVELOPE_FIXES: readonly string[] = [
  'A live correction is one word for one word, on one line of the one target file.',
];
const NOT_VISIBLE = refuseCommand(
  'NOT_FOUND',
  [],
  ['No live correction by that identity in this business.', 'Name one you can see.'],
);
const UNCONFIGURED = refuseCommand(
  'APPROVER_NOT_CONFIGURED',
  [],
  ['An administrator names the approver with settings.set_live_correction_approver.'],
);
const NOT_THE_APPROVER = refuseCommand(
  'APPROVER_NOT_CONFIGURED_ONE',
  [],
  ['Only the configured staff approver approves a live correction.'],
);
const SELF = refuseCommand(
  'SELF_APPROVAL_REFUSED',
  [],
  ['A second person approves the change; ask the configured approver.'],
);
const DECIDED = refuseCommand('GATE_ALREADY_DECIDED', [], ['This correction is decided already.']);
const STALE = refuseCommand(
  'VERSION_STALE',
  ['versionId'],
  ['Read the correction again and approve the version it shows.'],
);
const DECISION_FIXES: readonly string[] = ['A decision is approve or reject.'];
const TASK_ABSENT = refuseCommand(
  'NOT_FOUND',
  ['taskId'],
  ['Name a task in this business for the correction to be worked under.'],
);

async function taskExists(tx: TenantQuery, taskTypeId: string, taskId: string): Promise<boolean> {
  const rows = await tx.query<{ readonly id: string }>(
    `select id from public.records
      where business_id = $1 and id = $2 and record_type_id = $3 and deleted_at is null`,
    [tx.businessId, taskId, taskTypeId],
  );
  return rows.length > 0;
}

/** Who asked: a person as themselves, or an agent inside a delegation for that person. */
export interface Requester {
  readonly actorId: string;
  readonly personId: string;
  readonly delegationId: string | null;
}

export type RequestOperands = Omit<Of<'live_correction.request'>, 'command' | 'operationId'>;

/**
 * Check the envelope, then store. Shared by the person command and the agent's
 * row (`agent-operations.ts`), each of which has already asked its own
 * authority at the named party.
 */
export async function storeRequest(
  tx: TenantQuery,
  taskTypeId: string,
  requester: Requester,
  request: RequestOperands,
): Promise<HandlerOutcome> {
  const target = { path: request.path, word: request.word, replacement: request.replacement };
  const change = { files: [{ path: request.path, before: request.before, after: request.after }] };
  const envelope = checkEnvelope(change, target);
  if (!envelope.ok) {
    return refused(
      refuseCommand('CHANGE_ENVELOPE_EXCEEDED', [], [envelope.reason, ...ENVELOPE_FIXES]),
    );
  }
  if (!(await taskExists(tx, taskTypeId, request.taskId))) return refused(TASK_ABSENT);

  const preImageDigest = contentDigest(request.before);
  const stored = await insertLiveCorrection(tx, {
    partyId: request.partyId,
    taskId: request.taskId,
    requestedByActorId: requester.actorId,
    requestedByPersonId: requester.personId,
    delegationId: requester.delegationId,
    targetPath: request.path,
    word: request.word,
    replacement: request.replacement,
    pageUrl: request.pageUrl,
    preImageDigest,
    baseRevision: request.baseRevision,
    seam: `seam-${randomUUID()}`,
    versionDigest: contentDigest({
      target,
      change,
      preImageDigest,
      baseRevision: request.baseRevision,
      pageUrl: request.pageUrl,
    }),
  });
  return applied(stored.id, stored.revision, {
    correctionId: stored.id,
    versionId: stored.versionId,
    versionDigest: stored.versionDigest,
    state: stored.state,
  });
}

export async function requestLiveCorrection(
  tx: TenantQuery,
  context: CommandContext,
  request: Of<'live_correction.request'>,
): Promise<HandlerOutcome> {
  const { session } = context;
  // The task the correction is worked under is one the caller can read, and
  // one they cannot is answered as a task that is not there.
  const readable = await checkAuthority(tx, subjectsOf(session), {
    collection: 'task',
    action: 'read',
    scope: { kind: 'record', id: request.taskId },
  });
  if (!readable.ok) return refused(TASK_ABSENT);
  return await storeRequest(
    tx,
    context.spine.taskTypeId,
    { actorId: session.actorId, personId: session.personId, delegationId: null },
    request,
  );
}

export async function approveLiveCorrection(
  tx: TenantQuery,
  context: CommandContext,
  request: Of<'live_correction.approve'>,
): Promise<HandlerOutcome> {
  if (request.decision !== 'approve' && request.decision !== 'reject') {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['decision'], DECISION_FIXES));
  }
  const { session } = context;
  const correction = await lockCoveredCorrection(tx, request.correctionId, {
    subjects: subjectsOf(session),
    collection: GATE_COLLECTION,
    action: 'decide',
  });
  if (correction === undefined) return refused(NOT_VISIBLE);
  if (correction.requestedByPersonId === session.personId) return refused(SELF);
  const approver = await lockConfiguredApprover(tx);
  if (approver === undefined || !(await isActiveMember(tx, approver))) {
    return refused(UNCONFIGURED);
  }
  if (approver !== session.personId) return refused(NOT_THE_APPROVER);
  if (correction.state !== 'requested') return refused(DECIDED);
  if (correction.versionId !== request.versionId) return refused(STALE);

  const decided = await writeCorrectionDecision(tx, {
    id: correction.id,
    decision: request.decision === 'approve' ? 'approved' : 'rejected',
    actorId: session.actorId,
    personId: session.personId,
  });
  return applied(decided.id, decided.revision, {
    correctionId: decided.id,
    versionId: decided.versionId,
    state: decided.state,
  });
}

const OPERAND_NAMES = [
  'partyId',
  'taskId',
  'path',
  'word',
  'replacement',
  'pageUrl',
  'baseRevision',
  'before',
  'after',
] as const;

/** The agent row's operands: every one a string, or the refusal naming those that are not. */
export function requestOperands(
  request: Readonly<Record<string, unknown>>,
): RequestOperands | ReturnType<typeof refused> {
  const wrong = OPERAND_NAMES.filter((name) => typeof request[name] !== 'string');
  if (wrong.length > 0) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', wrong, ['Send each operand as text.']));
  }
  return Object.fromEntries(OPERAND_NAMES.map((name) => [name, request[name]])) as RequestOperands;
}

const OUTSIDE_DELEGATION = refuseCommand(
  'DELEGATION_EXCLUDES_OPERATION',
  ['live_correction.request'],
  ['This delegation does not carry run:write on the task it was minted for.'],
);

/**
 * `live correction requested` by an agent, inside its delegation (the
 * permissions table: `run:write`, an agent may hold it inside its
 * delegation). The delegation must carry `run` and `write`, the correction is
 * worked under the delegation's own task, and the delegating person's live
 * grant must cover `run:write` at the named party now. The person recorded as
 * the requester is the delegating person, so they cannot approve it either.
 */
export async function requestAsAgent(
  tx: TenantQuery,
  agentActorId: string,
  operands: RequestOperands,
  delegation: Delegation,
): Promise<HandlerOutcome> {
  const carries =
    delegation.collections.includes(RUN_COLLECTION) && delegation.actions.includes('write');
  if (!carries || delegation.purposeScope.id !== operands.taskId) {
    return refused(OUTSIDE_DELEGATION);
  }
  const covered = await checkAuthority(tx, [{ kind: 'person', id: delegation.delegatePersonId }], {
    collection: RUN_COLLECTION,
    action: 'write',
    scope: { kind: 'party', id: operands.partyId },
  });
  if (!covered.ok) return refused(covered.refusal);
  const spine = await readTaskSpine(tx);
  return await storeRequest(
    tx,
    spine.taskTypeId,
    { actorId: agentActorId, personId: delegation.delegatePersonId, delegationId: delegation.id },
    operands,
  );
}
