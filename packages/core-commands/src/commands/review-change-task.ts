// SPDX-License-Identifier: AGPL-3.0-only
//
// C57 part B (#2117): `review.make_change_task`, a worker making an approved change request a
// task under its live lease on the review's task. The request is held under the lease and the
// grants it stands on (`holdApprovedChange`, the check `correction-receipts.ts` makes), read
// again after the lock wait; the task is made through `task.create`'s own handler, a subtask
// of the review's task, so it carries that task's client and the caller's derived source, and
// keeps field validation and placement. The first-client gate is the envelope's, as for every
// write. The body names the lease and the request only: no client, parent, source or field.
// The task and its link to the request commit together, and the request's one task means two
// calls at once or a lost answer asked again make one; a retry answers the task already made.
// Proposing and approving make nothing: no task exists until a worker asks.

import {
  advisoryLock,
  holdApprovedChange,
  isUuid,
  linkChangeTask,
  NO_ASSURANCE,
} from '../../../core-records/src/index.ts';
import type {
  Delegation,
  EntryPoint,
  HeldChange,
  LeaseAt,
  ObservedRefusal,
  Session,
  TenantQuery,
} from '../../../core-records/src/index.ts';
import type { CommandDeclaration } from '../../../core-wire/src/index.ts';
import type { AgentCall } from './agent-call.ts';
import { readTaskSpine, type CommandContext } from './context.ts';
import type { CommandRequest } from './requests.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from './refusal.ts';
import { applied, isRefused, refused, type HandlerOutcome, type JudgedLast } from './outcome.ts';
import { createTask } from './tasks-write.ts';

type Of<K extends CommandRequest['command']> = CommandRequest & { readonly command: K };

/** The made task's title; the request's own words go in its description, the team's only. */
const TITLE = 'Change requested in review';

const LEASE_FIX = ['Ask again under the live lease you hold on the review’s task, at its fence.'];

const REFUSALS: Readonly<Record<ObservedRefusal, CommandRefusal>> = {
  LEASE_NOT_OWNED: refuseCommand('LEASE_NOT_OWNED', ['leaseId'], LEASE_FIX),
  DELEGATION_NARROWED: refuseCommand(
    'DELEGATION_NARROWED',
    ['leaseId'],
    ['The person this lease works for no longer holds the write it draws on.'],
  ),
  NOT_FOUND: refuseNotFound(),
  GATE_NOT_APPROVED: refuseNotFound(),
};

const MISSING_REQUEST = refuseCommand(
  'FIELD_VALUE_INVALID',
  ['changeRequestId'],
  ['Send changeRequestId as an identifier.'],
);

export interface MakeChangeTask {
  readonly leaseId: unknown;
  readonly fence: unknown;
  readonly changeRequestId: unknown;
  readonly operationId: string;
}

/** Who makes it: the lease's holder, and the session `task.create` sees for them. */
interface Maker {
  readonly session: Session;
  readonly declaration: CommandDeclaration;
  readonly entryPoint: EntryPoint;
}

/**
 * The task made, or the one already made, judged once more after the agent path's last waits
 * on its actor, login and audit chain (`agent-standing.ts`): the lease, its delegation and the
 * person's grants held again, so one that lapsed there answers no task and rolls back any made.
 */
const made = (
  tx: TenantQuery,
  at: LeaseAt,
  held: { readonly id: string },
  taskId: string,
  revision: number | null,
) => ({
  ...applied(taskId, revision, { changeRequestId: held.id, taskId }),
  lastCheck: async () => {
    const after = await holdApprovedChange(tx, at, held.id);
    return after.ok ? undefined : REFUSALS[after.code];
  },
});

async function makeTask(
  tx: TenantQuery,
  maker: Maker,
  at: LeaseAt,
  held: Extract<HeldChange, { pending: true }>,
  operationId: string,
): Promise<JudgedLast> {
  const context: CommandContext = {
    ...maker,
    spine: await readTaskSpine(tx),
    target: undefined,
    carrier: undefined,
  };
  const created = await createTask(tx, context, {
    command: 'task.create',
    operationId,
    fields: { title: TITLE, description: held.text },
    parentId: held.taskId,
  });
  if (isRefused(created)) return created;
  // The placement can wait on the sibling set after the lease was judged, and so can the audit
  // chain, and a lease cannot end under its share lock but can run out. So the chain's lock is
  // taken here (the envelope's last wait) and the lease judged again after it: a lapsed one makes
  // nothing.
  await advisoryLock(tx, tx.businessId.toLowerCase());
  const still = await holdApprovedChange(tx, at, held.id);
  if (!still.ok) return refused(REFUSALS[still.code]);
  const taskId = String(created.recordId);
  await linkChangeTask(tx, held.id, taskId);
  return made(tx, at, held, taskId, created.revision);
}

/** The one path: the request held under the lease, then its task made or the one already made. */
export async function makeChangeTask(
  tx: TenantQuery,
  maker: Maker,
  request: MakeChangeTask,
): Promise<JudgedLast> {
  const { leaseId, fence, changeRequestId } = request;
  // An id left out is the caller's to send; a malformed one names nothing, as a fabricated one.
  if (typeof changeRequestId !== 'string') return refused(MISSING_REQUEST);
  if (!isUuid(changeRequestId)) return refused(refuseNotFound());
  if (typeof leaseId !== 'string' || !isUuid(leaseId) || !Number.isSafeInteger(fence)) {
    return refused(REFUSALS.LEASE_NOT_OWNED);
  }
  const at = {
    leaseId: leaseId.toLowerCase(),
    fence: Number(fence),
    actorId: maker.session.actorId,
  };
  const held = await holdApprovedChange(tx, at, changeRequestId.toLowerCase());
  if (!held.ok) return refused(REFUSALS[held.code]);
  const change = held.subject;
  if (!change.pending) return made(tx, at, change, change.createdTaskId, null);
  return await makeTask(tx, maker, at, change, request.operationId);
}

/** A person under a lease of their own, as `task.handback` takes one. */
export async function makeChangeTaskAsPerson(
  tx: TenantQuery,
  context: CommandContext,
  request: Of<'review.make_change_task'>,
): Promise<HandlerOutcome> {
  return await makeChangeTask(tx, context, request);
}

/**
 * The worker's row: the dispatcher reads the task from the lease the body names and asks the
 * delegation's `task:write` there before this runs. The task is the agent's, made for the
 * delegating person, with no ticked keys of its own (`credentialScope` empty), so a wayfinder
 * map's owner check, which reads them, refuses it.
 */
export async function serveMakeChangeTask(
  tx: TenantQuery,
  { session, request, declaration }: AgentCall,
  _operands: object,
  delegation: Delegation,
): Promise<JudgedLast> {
  const maker: Maker = {
    session: {
      businessId: tx.businessId,
      loginId: session.loginId,
      personId: delegation.delegatePersonId,
      actorId: session.actorId,
      roleKey: null,
      assurance: NO_ASSURANCE,
      credentialScope: [],
    },
    declaration,
    entryPoint: 'api',
  };
  return await makeChangeTask(tx, maker, {
    leaseId: request['leaseId'],
    fence: request['fence'],
    changeRequestId: request['changeRequestId'],
    operationId: String(request['operationId']),
  });
}

/** The agent row: a lease row, as `task.handback`'s, its task read from the lease. */
export const MAKE_CHANGE_TASK: {
  readonly authority: 'record';
  readonly subjectTask: 'lease';
  readonly replay: 'reauthorise';
  readonly operands: () => Readonly<Record<string, never>>;
  readonly serve: typeof serveMakeChangeTask;
} = {
  authority: 'record',
  subjectTask: 'lease',
  replay: 'reauthorise',
  operands: () => ({}),
  serve: serveMakeChangeTask,
};
