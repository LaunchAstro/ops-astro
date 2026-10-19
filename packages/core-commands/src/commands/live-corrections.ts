// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's two commands, `live correction requested` and `approved` (the permissions table of #765).
// The request names the task, the page and the two words (#1693): a word pair that is not one word
// for one other is refused with nothing stored, and the page is resolved on the task's own site in
// the insert. It is stored `locating`: the site runner pins the version from the file itself, so
// no caller supplies a revision, a file or a digest, and nothing stores the file's text. The
// approval names the version, and lands only while the runner's last check of the page is at most
// 60 s old, read after every lock wait (`writeCorrectionDecision`). The approval refuses a
// caller outside the staff roles before reading any correction, locks the row at its
// party, reads the configured approver under a share lock on its setting, and refuses the requester
// first: a person cannot approve their own change even when they are the configured approver
// (release decision 3.4). Each write reads its authority again after its last
// lock wait (`live-correction-standing.ts`); an agent's request is
// `live-correction-agent.ts`.
//
// Refusals carry fixed text only: no word, path, page or content reaches a refused caller.

import { randomUUID } from 'node:crypto';
import {
  checkAuthority,
  correctionOfPlan,
  GATE_COLLECTION,
  insertLiveCorrection,
  RUN_COLLECTION,
  isActiveMember,
  isVerifiedNow,
  isUuid,
  lockConfiguredApprover,
  lockCoveredCorrection,
  subjectsOf,
  writeCorrectionDecision,
} from '../../../core-records/src/index.ts';
import type { Subject, TenantQuery } from '../../../core-records/src/index.ts';
import { wordPairRefusal } from '../../../core-connectors/src/index.ts';
import { isInternalReader } from '../reads/tasks.ts';
import type { CommandContext } from './context.ts';
import type { CommandRequest } from './requests.ts';
import { refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { endedRefusal, standsAfterWaits } from './live-correction-standing.ts';
import { approverConfigured, decisionRefusal } from './live-correction-decision-checks.ts';
import { refuseUnstorable, unstorableOperands } from './values.ts';

export { setApprover } from './live-correction-approver.ts';

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
const NOT_READY = refuseCommand(
  'VERSION_NOT_READY',
  ['versionId'],
  ['This correction has no version to decide: ask for the change again.'],
);
const UNVERIFIED = refuseCommand(
  'VERSION_UNVERIFIED',
  ['versionId'],
  ['The page has not been checked in the last minute. Read the correction again shortly.'],
);
/** States with no version a decision may name (#1693, the guard order's first step). */
const UNREADY = new Set(['locating', 'unlocated', 'superseded']);
const DECISION_FIXES: readonly string[] = ['A decision is approve or reject.'];
const TASK_ABSENT = refuseCommand(
  'NOT_FOUND',
  ['taskId'],
  ['Name a task in this business for the correction to be worked under.'],
);
// One body for an unbound name, another holder's page and an ambiguous one.
const PAGE_ABSENT = refuseCommand(
  'NOT_FOUND',
  ['page'],
  ['Name a page of the task’s own site, as the site holds it.'],
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
  /** Whose run:write the request rests on, read again after the insert's lock wait. */
  readonly subjects: readonly Subject[];
  /** An agent's accepted plan version, which holds one correction (#1717); absent for a person. */
  readonly planVersionId?: string;
}

export type RequestOperands = Omit<Of<'live_correction.request'>, 'command' | 'operationId'>;

/**
 * Check the word pair, then store `locating`. Shared by the person command and
 * the agent's row (`agent-operations.ts`), each of which has already asked its
 * own authority at the task's client.
 */
export async function storeRequest(
  tx: TenantQuery,
  taskTypeId: string,
  requester: Requester,
  request: RequestOperands,
): Promise<HandlerOutcome> {
  const pair = wordPairRefusal(request);
  if (pair !== undefined) {
    return refused(refuseCommand('CHANGE_ENVELOPE_EXCEEDED', [], [pair, ...ENVELOPE_FIXES]));
  }
  if (!(await taskExists(tx, taskTypeId, request.taskId))) return refused(TASK_ABSENT);
  const { planVersionId } = requester;
  const drafted =
    planVersionId === undefined ? undefined : await correctionOfPlan(tx, planVersionId);
  const inserted =
    drafted ??
    (await insertLiveCorrection(tx, {
      taskId: request.taskId,
      requestedByActorId: requester.actorId,
      requestedByPersonId: requester.personId,
      delegationId: requester.delegationId,
      page: request.page,
      word: request.word,
      replacement: request.replacement,
      seam: `seam-${randomUUID()}`,
      planVersionId: planVersionId ?? null,
    }));
  // A request at once on the same plan waited on the first's insert and stored nothing: the first answers it.
  const stored =
    'code' in inserted && planVersionId !== undefined
      ? ((await correctionOfPlan(tx, planVersionId)) ?? inserted)
      : inserted;
  // The page is one of the task's own site's: else nothing is stored.
  if ('code' in stored) return refused(PAGE_ABSENT);
  const ended = await endedSince(tx, requester, stored.partyId);
  if (ended !== undefined) return ended;
  return applied(stored.id, stored.revision, { correctionId: stored.id, state: stored.state });
}

/** After the insert's wait: an approver still set, then the requester's authority again. */
async function endedSince(
  tx: TenantQuery,
  requester: Requester,
  partyId: string | null,
): Promise<ReturnType<typeof refused> | undefined> {
  if (!(await approverConfigured(tx))) return refused(UNCONFIGURED);
  const { delegationId } = requester;
  const stood = await standsAfterWaits(tx, {
    covering: { subjects: requester.subjects, collection: RUN_COLLECTION, action: 'write' },
    partyId,
    ...(delegationId === null ? {} : { delegationId }),
  });
  return stood === 'stands' ? undefined : refused(endedRefusal(stood, delegationId !== null));
}

export async function requestLiveCorrection(
  tx: TenantQuery,
  context: CommandContext,
  request: Of<'live_correction.request'>,
): Promise<HandlerOutcome> {
  const { session } = context;
  const operands = typedOperands(request);
  if ('refusal' in operands) return operands;
  // The task the correction is worked under is one the caller can read, and
  // one they cannot is answered as a task that is not there.
  const readable = await checkAuthority(tx, subjectsOf(session), {
    collection: 'task',
    action: 'read',
    scope: { kind: 'record', id: operands.taskId },
  });
  if (!readable.ok) return refused(TASK_ABSENT);
  return await storeRequest(
    tx,
    context.spine.taskTypeId,
    {
      actorId: session.actorId,
      personId: session.personId,
      delegationId: null,
      subjects: subjectsOf(session),
    },
    operands,
  );
}

export async function decideLiveCorrection(
  tx: TenantQuery,
  context: CommandContext,
  request: Of<'live_correction.decide'>,
): Promise<HandlerOutcome> {
  if (request.decision !== 'approve' && request.decision !== 'reject') {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['decision'], DECISION_FIXES));
  }
  const { session } = context;
  if (!isInternalReader(session.roleKey)) return refused(NOT_THE_APPROVER);
  // A malformed id names no correction, as a fabricated one does.
  if (!isUuid(request.correctionId)) return refused(NOT_VISIBLE);
  const gate = { subjects: subjectsOf(session), collection: GATE_COLLECTION, action: 'decide' };
  const correction = await lockCoveredCorrection(tx, request.correctionId, gate);
  if (correction === undefined) return refused(NOT_VISIBLE);
  if (correction.requestedByPersonId === session.personId) return refused(SELF);
  const approver = await lockConfiguredApprover(tx);
  if (approver === undefined || !(await isActiveMember(tx, approver))) {
    return refused(UNCONFIGURED);
  }
  if (approver.toLowerCase() !== session.personId) return refused(NOT_THE_APPROVER);
  // The guard order (#1693): no version yet, then decided, then the version, then its check.
  if (UNREADY.has(correction.state)) return refused(NOT_READY);
  if (correction.state !== 'requested') return refused(DECIDED);
  if (correction.versionId !== request.versionId.toLowerCase()) return refused(STALE);
  const approve = request.decision === 'approve';
  if (approve && !(await isVerifiedNow(tx, correction.id))) return refused(UNVERIFIED);
  const after = await decisionRefusal(tx, correction, { gate, unseen: NOT_VISIBLE });
  if (after !== undefined) return refused(after);

  // The approval is decided here, its check read again after every wait above.
  const decided = await writeCorrectionDecision(tx, {
    id: correction.id,
    decision: approve ? 'approved' : 'rejected',
    actorId: session.actorId,
    personId: session.personId,
  });
  if (decided === undefined) return refused(UNVERIFIED);
  return applied(decided.id, decided.revision, {
    correctionId: decided.id,
    versionId: decided.versionId,
    state: decided.state,
  });
}

const OPERAND_NAMES = ['taskId', 'page', 'word', 'replacement'] as const;

/**
 * The agent row's operands, taken as sent: their shape is judged after the
 * delegation (`live-correction-agent.ts`), so a caller holding nothing is told that
 * first, as every agent row answers.
 */
export function requestOperands(
  request: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(OPERAND_NAMES.map((name) => [name, request[name]]));
}

/**
 * The request's operands as both paths store them: identifiers in their
 * canonical lower case, and every text one the stores can hold.
 */
export function typedOperands(
  operands: Readonly<Record<string, unknown>>,
): RequestOperands | ReturnType<typeof refused> {
  const wrong = OPERAND_NAMES.filter((name) =>
    name === 'taskId' ? !isUuid(operands[name]) : typeof operands[name] !== 'string',
  );
  if (wrong.length > 0) {
    return refused(
      refuseCommand('FIELD_VALUE_INVALID', wrong, [
        'Send taskId as an identifier, and the page and the two words as text.',
      ]),
    );
  }
  const unstorable = unstorableOperands(operands, OPERAND_NAMES);
  if (unstorable.length > 0) return refused(refuseUnstorable(unstorable));
  const typed = operands as unknown as RequestOperands;
  return { ...typed, taskId: typed.taskId.toLowerCase() };
}
