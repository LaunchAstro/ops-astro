// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's `live correction requested` (the permissions table of #765). The request is checked
// against the envelope before anything is written, so a change of more than one word on one line
// of one file is refused with nothing stored; what is stored is the target, the digests and the
// version the approval must name, never the file's text. The approval is
// `live-correction-decide.ts`. Each write reads its authority again after its last lock wait
// (`live-correction-standing.ts`); an agent's request is `live-correction-agent.ts`.
//
// Refusals carry fixed text only: no word, path, page or content reaches a refused caller.

import { randomUUID } from 'node:crypto';
import {
  checkAuthority,
  insertLiveCorrection,
  RUN_COLLECTION,
  isUuid,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type { Subject, TenantQuery } from '../../../core-records/src/index.ts';
import {
  checkEnvelope,
  contentDigest,
  versionDigestOf,
} from '../../../core-connectors/src/index.ts';
import type { CommandContext } from './context.ts';
import type { CommandRequest } from './requests.ts';
import { refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { endedRefusal, standsAfterWaits } from './live-correction-standing.ts';
import { approverConfigured } from './live-correction-decision-checks.ts';
import { refuseUnstorable, unstorableOperands } from './values.ts';

export { setApprover } from './live-correction-approver.ts';
export { decideLiveCorrection } from './live-correction-decide.ts';

type Of<K extends CommandRequest['command']> = CommandRequest & { readonly command: K };

const ENVELOPE_FIXES: readonly string[] = [
  'A live correction is one word for one word, on one line of the one target file.',
];
const UNCONFIGURED = refuseCommand(
  'APPROVER_NOT_CONFIGURED',
  [],
  ['An administrator names the approver with settings.set_live_correction_approver.'],
);
const TASK_ABSENT = refuseCommand(
  'NOT_FOUND',
  ['taskId'],
  ['Name a task in this business for the correction to be worked under.'],
);
const PARTY = refuseCommand('CORRECTION_PARTY_MISMATCH', ['partyId'], ['Name the task’s client.']);
const STORE_REFUSALS = {
  CORRECTION_PARTY_MISMATCH: PARTY,
  PAGE_OUTSIDE_PARTY_SITE: refuseCommand(
    'PAGE_OUTSIDE_PARTY_SITE',
    ['pageUrl', 'path'],
    ['Name a page of this client’s own site, and its file, as the site holds them.'],
  ),
} as const;

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
  const seam = `seam-${randomUUID()}`;
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
    seam,
    versionDigest: versionDigestOf({
      target,
      change,
      preImageDigest,
      baseRevision: request.baseRevision,
      pageUrl: request.pageUrl,
      seam,
    }),
  });
  // The party is the task's client (P26 low 4), the page its site's: else nothing is stored.
  if ('code' in stored) return refused(STORE_REFUSALS[stored.code]);
  const ended = await endedSince(tx, requester, stored.partyId);
  if (ended !== undefined) return ended;
  return applied(stored.id, stored.revision, {
    correctionId: stored.id,
    versionId: stored.versionId,
    versionDigest: stored.versionDigest,
    state: stored.state,
  });
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
  const wrong = OPERAND_NAMES.filter((name) => {
    if (name === 'partyId') return operands[name] !== null && !isUuid(operands[name]);
    return name === 'taskId' ? !isUuid(operands[name]) : typeof operands[name] !== 'string';
  });
  if (wrong.length > 0) {
    return refused(
      refuseCommand('FIELD_VALUE_INVALID', wrong, [
        'Send taskId as an identifier, partyId as one or null, and the rest as text.',
      ]),
    );
  }
  const unstorable = unstorableOperands(operands, OPERAND_NAMES);
  if (unstorable.length > 0) return refused(refuseUnstorable(unstorable));
  const typed = operands as unknown as RequestOperands;
  const partyId = typed.partyId?.toLowerCase() ?? null;
  return { ...typed, partyId, taskId: typed.taskId.toLowerCase() };
}
