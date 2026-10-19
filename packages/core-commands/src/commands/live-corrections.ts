// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's `live correction requested` (the permissions table of #765). The request names the task,
// the page and the two texts (#1693): a pair that is not one phrase or sentence on one line for
// another (#1987) is refused with nothing stored, and the page is resolved on the task's own site
// in the insert. It is stored `locating`: the site runner pins the version from the file itself,
// so no caller supplies a revision, a file or a digest, and nothing stores the file's text. The
// approval is `live-correction-decide.ts`. Each write reads its authority again after its last
// lock wait (`live-correction-standing.ts`); an agent's request is `live-correction-agent.ts`.
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
import { wordPairRefusal } from '../../../core-connectors/src/index.ts';
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
  'A live correction is one phrase or sentence on one line, in the one target file.',
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
  const stored = await insertLiveCorrection(tx, {
    taskId: request.taskId,
    requestedByActorId: requester.actorId,
    requestedByPersonId: requester.personId,
    delegationId: requester.delegationId,
    page: request.page,
    word: request.word,
    replacement: request.replacement,
    seam: `seam-${randomUUID()}`,
  });
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
