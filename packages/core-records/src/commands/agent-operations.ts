// SPDX-License-Identifier: AGPL-3.0-only
//
// Each agent operation as one row: where its task comes from, which authority
// check it answers to, the operands it reads, what it does, how its replay is
// released and what it keeps when refused. The agent entry
// (`agent-envelope.ts`) runs every row through the same pipeline, so adding an
// operation is adding a row here rather than a branch in each step of it.

import type { TenantQuery } from '../tenancy/database.ts';
import type { AgentSession } from '../identity/agent-login.ts';
import { checkDelegatedAuthority, type Delegation } from '../authority/delegations.ts';
import { readQueue } from '../reads/queue.ts';
import { READ_CATALOGUE } from '../reads/catalogue.ts';
import { READ_BODY_FIXES } from '../reads/dispatch.ts';
import { readTaskDetail } from '../reads/tasks.ts';
import { businessKeyOf, type AgentCapabilities, type Capability } from '../reads/capabilities.ts';
import { readTaskSpine } from './context.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from './refusal.ts';
import { isFieldMap } from './operands.ts';
import type { CommandName } from './surface.ts';
import { handbackLease } from './tasks-handback.ts';
import { MAXIMUM_LEASE_SECONDS, pickupReservation } from './tasks-pickup.ts';
import { heartbeatLease, leaseSecondsFixes } from './tasks-lease.ts';
import { MAXIMUM_RENEWAL_SECONDS } from '../../../core-runtime/src/heartbeat.ts';
import { agentClaimant } from './tasks-claimant.ts';
import { writeTaskComment } from './tasks-comment.ts';
import { refused, type HandlerOutcome, type Refused } from './outcome.ts';
import {
  claimedSystemFields,
  irrelevantIdentifiers,
  lockTask,
  SYSTEM_OWNED_FIXES,
} from './prepare.ts';
import { retainLateHandback } from './agent-late-handback.ts';
import type { AgentCall, AgentOperands, AgentRequest } from './agent-call.ts';

/** What every kind of agent operation carries. */
interface AgentOperationRow {
  /**
   * The identifier fields a read takes, from its person row (`READ_CATALOGUE`),
   * so the two entries refuse the same stray field in the same words. Any
   * other is refused before the operands (Sol 6 AUTHORITY-3). Absent on a
   * command, whose identifiers its own operands and handler read.
   */
  readonly identifiers?: readonly string[];
  /** The operands read before any authority, after the system-owned fields. */
  readonly operands?: (request: AgentRequest) => AgentOperands | Refused;
  /** How a stored success is released on replay (`agent-replay.ts`). */
  readonly replay: 'reauthorise' | 'pickup' | 'capabilities' | 'settledHandback';
  /** What an authority refusal keeps, when the operation keeps anything. */
  readonly onRefused?: (
    tx: TenantQuery,
    call: AgentCall,
    operands: AgentOperands,
    refusal: CommandRefusal,
  ) => Promise<void>;
}

/** What a delegated operation does, under the delegation `authorise` resolved. */
type DelegatedServe = (
  tx: TenantQuery,
  call: AgentCall,
  operands: AgentOperands,
  delegation: Delegation,
) => Promise<HandlerOutcome>;

/**
 * What a record operation does: under the delegation, on the task the check
 * was made on (`authorise`), or `undefined` when the call named none and the
 * check fell back to the delegation's own scope. Never the body read again.
 */
type RecordServe = (
  tx: TenantQuery,
  call: AgentCall,
  operands: AgentOperands,
  delegation: Delegation,
  taskId: string | undefined,
) => Promise<HandlerOutcome>;

/**
 * One agent operation, by the check `authorise` (`agent-authority.ts`) asks,
 * so a row says whether it runs under a delegation and nothing has to find
 * out again (THERMO-RECHECK NA1):
 *
 * - `beforePickup`, the pair an agent login reaches holding nothing, served
 *   under no delegation;
 * - `purpose`, `read` on the delegation's own purpose record;
 * - `record`, the operation's own collection and action on the task the call
 *   is about, found where `subjectTask` says;
 * - `decision`, L4's `decideAsAgent`, which always refuses, so it has no
 *   `serve` at all.
 */
export type AgentOperation =
  | (AgentOperationRow & {
      readonly authority: 'beforePickup';
      readonly serve: (
        tx: TenantQuery,
        call: AgentCall,
        operands: AgentOperands,
      ) => Promise<HandlerOutcome>;
    })
  | (AgentOperationRow & { readonly authority: 'purpose'; readonly serve: DelegatedServe })
  | (AgentOperationRow & {
      readonly authority: 'record';
      /** Where the check finds its task: the lease the body names, or the record. */
      readonly subjectTask: 'lease' | 'record';
      readonly serve: RecordServe;
    })
  | (AgentOperationRow & { readonly authority: 'decision' });

/** What a delegated agent may write a comment in: its team's notes, not the client's thread. */
const AGENT_AUDIENCES: ReadonlySet<string> = new Set(['internal']);

const REPORT_FIXES: readonly string[] = [
  'Send report as an object of named values, or leave it out.',
];

const ACTUAL_MINOR_FIXES: readonly string[] = [
  'Leave actualMinor out, or send null: nothing in this head dispatches.',
  'A number here would claim the work ran and cost that much.',
];

/**
 * The operands' shape rules. A present operand of the wrong shape is refused
 * by name. It is never the default in disguise, and a report is never dropped
 * or turned into an object with numeric keys: a caller that sent something
 * and got the default back would believe the server had read what it sent.
 * Absent keeps the default. Range belongs to the handler
 * (`pickupReservation`, `heartbeatLease`), which already refuses an
 * out-of-range lease in the same code.
 */
function leaseSecondsOperand(maximum: number): (request: AgentRequest) => AgentOperands | Refused {
  return (request) => {
    if (!('leaseSeconds' in request)) return {};
    const seconds = request['leaseSeconds'];
    if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0) {
      // The person entry's words for the same route (`readLeaseSeconds`), so
      // the two entries tell a caller one thing (thermo O4).
      return refused(
        refuseCommand('FIELD_VALUE_INVALID', ['leaseSeconds'], leaseSecondsFixes(maximum)),
        {
          leaseSeconds: seconds,
        },
      );
    }
    return { leaseSeconds: seconds };
  };
}

/**
 * The reservation a pickup names, as the string it was sent as. Anything else
 * is the person entry's refusal in its words (`pickupAsPerson`): `String(...)`
 * would have turned `[id]` into the id and claimed it (Sol 6 AUTHORITY-2).
 * Whether the string names a claimable reservation is the handler's.
 */
function pickupOperands(request: AgentRequest): AgentOperands | Refused {
  const reservationId = request['reservationId'];
  if (typeof reservationId !== 'string') {
    // No attempted value, as the person entry records none for it: the two
    // audit rows are the same row (`tests/api/id-operand-shape.test.ts`).
    return refused(
      refuseCommand(
        'COMMAND_BODY_INVALID',
        ['reservationId'],
        ['Name a reservation from task.queue.'],
      ),
    );
  }
  const lease = leaseSecondsOperand(MAXIMUM_LEASE_SECONDS)(request);
  if ('refusal' in lease) return lease;
  return { ...lease, reservationId };
}

function handbackOperands(request: AgentRequest): AgentOperands | Refused {
  // The outcome and the fence by their JSON type, in the order and words the
  // person handler asks them (`tasks-handback.ts`), and passed on as sent:
  // `String(["completed"])` is `"completed"` and `Number("1")` is `1`, which
  // settled a lease and, past a lapsed grant, kept a report the restricted
  // intake keeps only when otherwise valid (Sol 6 AUTHORITY-2). Whether the
  // string is an outcome and the number a fence is the handler's.
  const outcome = request['outcome'];
  if (typeof outcome !== 'string') {
    return refused(
      refuseCommand('FIELD_VALUE_INVALID', ['outcome'], ['An outcome is completed or failed.']),
      { outcome },
    );
  }
  const fence = request['fence'];
  if (typeof fence !== 'number') {
    return refused(
      refuseCommand('FIELD_VALUE_INVALID', ['fence'], ['Send the fence the pickup handed you.']),
      { fence },
    );
  }
  let operands: AgentOperands = { outcome, fence };
  if ('report' in request) {
    const report = request['report'];
    if (!isFieldMap(report)) {
      return refused(refuseCommand('FIELD_VALUE_INVALID', ['report'], REPORT_FIXES), { report });
    }
    operands = { ...operands, report };
  }
  // Any non-null actual is refused here, before authority is read, and not
  // only by the runtime past it. A handback refused on authority reaches the
  // restricted report intake (`retainLateHandback`), which keeps an otherwise
  // valid report; one claiming spend nothing in this head can have made is
  // not one, and is kept by no path (API.md; Sol 6 AUTHORITY-3). `null` and
  // absent are the same request.
  if ('actualMinor' in request) {
    const actualMinor = request['actualMinor'];
    if (actualMinor !== null && actualMinor !== undefined) {
      return refused(
        refuseCommand('ACTUAL_EXPENDITURE_UNSUPPORTED', ['actualMinor'], ACTUAL_MINOR_FIXES),
        { actualMinor },
      );
    }
  }
  return operands;
}

/**
 * A `recordId` that is present and not a string, refused before any authority
 * in the words the person prefix answers the same body with (`refusal`).
 *
 * `String(["<sibling>"])` is the sibling's id: the check used to take the
 * agent's own task for a non-string and `serve` then acted on the id the value
 * printed as, so an agent commented on and read a sibling task
 * (THERMO-RECHECK-2 NNA1). Absent stays absent: it is checked on the
 * delegation's own task and names nothing to serve.
 */
function recordIdOperand(
  refusal: (request: AgentRequest) => CommandRefusal | undefined,
): (request: AgentRequest) => AgentOperands | Refused {
  return (request) => {
    if (!('recordId' in request) || typeof request['recordId'] === 'string') return {};
    return refused(refusal(request) ?? refuseNotFound());
  };
}

/**
 * The request's system-owned fields refused, then its operands read.
 *
 * Neither tells the caller anything about the business, so both come before
 * any authority is read.
 */
export async function parseOperands(
  tx: TenantQuery,
  request: AgentRequest,
  operation: AgentOperation,
): Promise<AgentOperands | Refused> {
  // The envelope's own list and every installed `write_mode = 'system'` field
  // key, read from `field_defs`, the same classifier the person and read
  // routes use (root ruling 1).
  const claimed = await claimedSystemFields(tx, request);
  if (claimed !== undefined) {
    return refused(
      refuseCommand('FIELD_NOT_WRITABLE', claimed.keys, SYSTEM_OWNED_FIXES),
      claimed.values,
    );
  }
  // A target the read does not take, next and before any lookup, as the
  // person read path refuses it (`reads/dispatch.ts`): one answer for an own,
  // a foreign and a fabricated id.
  const irrelevant =
    operation.identifiers === undefined
      ? []
      : irrelevantIdentifiers(request, operation.identifiers);
  if (irrelevant.length > 0) {
    return refused(refuseCommand('COMMAND_BODY_INVALID', irrelevant, READ_BODY_FIXES));
  }
  return operation.operands?.(request) ?? {};
}

/**
 * What an agent may do under the delegation its credential resolved to, right
 * now. `authorise` has resolved it and checked its purpose is still reached.
 *
 * The pairs are the intersection root ruling 5 names: each collection and
 * action the delegation's purpose carries, kept only while the delegating
 * person's effective grants still cover it on the purpose record
 * (`checkDelegatedAuthority`, the same check a call makes). So a person who
 * keeps `read` and loses `write` to expiry leaves an agent told `read` and
 * not `write`, with no lifecycle write needed to say so. The pre-pickup pair
 * (`BEFORE_PICKUP`) is not a grant and is not in this list: it is what an
 * agent login reaches holding nothing, and it is refused this read.
 */
export async function capabilitiesOf(
  tx: TenantQuery,
  session: AgentSession,
  held: Delegation,
): Promise<AgentCapabilities> {
  const grants: Capability[] = [];
  for (const collection of held.collections) {
    for (const action of held.actions) {
      // Sequential: one transaction, one connection.
      // oxlint-disable-next-line no-await-in-loop
      const reach = await checkDelegatedAuthority(tx, held, {
        collection,
        action,
        scope: held.purposeScope,
      });
      if (reach.ok) grants.push({ collection, action });
    }
  }
  return {
    agentActorId: session.actorId,
    businessKey: await businessKeyOf(tx),
    purposeScope: held.purposeScope,
    grants,
  };
}

/** The person entry's answer for a task that is not there (`refuseNotFound`), word for word. */
const NOT_FOUND = (): Refused => refused(refuseNotFound());

async function serveComment(
  tx: TenantQuery,
  { session, request, declaration }: AgentCall,
  _operands: AgentOperands,
  _delegation: Delegation,
  taskId: string | undefined,
) {
  // The agent's own picked-up task: `authorise` has already held the
  // delegation's purpose scope to this record and its `comment` action to
  // the delegating person's live grant. The task is locked by the person
  // path's own `lockTask`, the same statement and filter (thermo O8), and the
  // comment commits with its own identity. `internal` only: a note to the
  // team, never text a client reads without a person having written it.
  if (taskId === undefined) return NOT_FOUND();
  const spine = await readTaskSpine(tx);
  const task = await lockTask(tx, spine.taskTypeId, taskId);
  if (task === undefined) return NOT_FOUND();
  return await writeTaskComment(
    tx,
    {
      commentTypeId: spine.taskCommentTypeId,
      declaration,
      target: { id: task.id, revision: task.revision },
      authorActorId: session.actorId,
      entryPoint: 'api',
      audiences: AGENT_AUDIENCES,
    },
    request['body'],
    request['audience'],
    request['commentType'],
  );
}

async function serveHeartbeat(
  tx: TenantQuery,
  { session, request }: AgentCall,
  operands: AgentOperands,
  delegation: Delegation,
) {
  // The delegation `authorise` resolved for this call. The runtime locks it
  // and asks again whether it is live before renewing (`heartbeat`).
  return await heartbeatLease(
    tx,
    {
      leaseId: request['leaseId'],
      fence: request['fence'],
      ...(operands.leaseSeconds === undefined ? {} : { leaseSeconds: operands.leaseSeconds }),
    },
    agentClaimant(session.actorId),
    delegation.id,
  );
}

/**
 * Every operation an agent may reach, in the order `AGENT_SURFACE` lists them.
 * `task.decide` is here to be refused by name (`decideAsAgent`), never served.
 */
export const AGENT_OPERATIONS: ReadonlyMap<CommandName, AgentOperation> = new Map<
  CommandName,
  AgentOperation
>([
  [
    'task.queue',
    {
      authority: 'beforePickup',
      replay: 'reauthorise',
      identifiers: READ_CATALOGUE['task.queue'].identifiers,
      serve: async (tx) => ({
        recordId: null,
        revision: null,
        detail: { queue: await readQueue(tx) },
      }),
    },
  ],
  [
    'task.pickup',
    {
      authority: 'beforePickup',
      replay: 'pickup',
      operands: pickupOperands,
      serve: async (tx, { session, declaration }, operands) =>
        await pickupReservation(tx, declaration.collection, session.actorId, {
          reservationId: operands.reservationId ?? '',
          ...(operands.leaseSeconds === undefined ? {} : { leaseSeconds: operands.leaseSeconds }),
        }),
    },
  ],
  [
    'task.handback',
    {
      authority: 'record',
      subjectTask: 'lease',
      replay: 'settledHandback',
      operands: handbackOperands,
      onRefused: retainLateHandback,
      serve: async (tx, { session, request }, operands) =>
        await handbackLease(
          tx,
          {
            // A lease id that is not a string names no lease, and the handler
            // answers it as one that does not exist.
            leaseId: typeof request['leaseId'] === 'string' ? request['leaseId'] : '',
            fence: operands.fence ?? Number.NaN,
            outcome: operands.outcome ?? '',
            // Carried through rather than dropped here, so that sending a number
            // is the refusal `handbackLease` spells out instead of a silence.
            ...('actualMinor' in request
              ? { actualMinor: request['actualMinor'] as number | null }
              : {}),
            ...(operands.report === undefined ? {} : { report: operands.report }),
            // The successor, untouched and unread. Whether the body is a shape
            // at all is `handbackLease`'s question, and a key checked here would
            // be a key checked twice; a key dropped here would be the silence
            // D06 refuses. What this entry point contributes is the half the
            // body may not carry: the agent actor below, never `proposedByActorId`.
            ...('successor' in request ? { successor: request['successor'] } : {}),
          },
          session.actorId,
        ),
    },
  ],
  [
    'task.heartbeat',
    {
      authority: 'record',
      subjectTask: 'lease',
      replay: 'reauthorise',
      operands: leaseSecondsOperand(MAXIMUM_RENEWAL_SECONDS),
      serve: serveHeartbeat,
    },
  ],
  [
    'task.read',
    {
      authority: 'record',
      subjectTask: 'record',
      replay: 'reauthorise',
      identifiers: READ_CATALOGUE['task.read'].identifiers,
      // The person read's own operand rule, so the two prefixes refuse a
      // non-string id in one body.
      operands: recordIdOperand((request) => {
        const read = READ_CATALOGUE['task.read'].parse(request);
        return read.ok ? undefined : read.refusal;
      }),
      serve: async (tx, _call, _operands, _delegation, taskId) => {
        if (taskId === undefined) return NOT_FOUND();
        const spine = await readTaskSpine(tx);
        const task = await readTaskDetail(tx, spine.taskTypeId, taskId, {
          commentTypeId: spine.taskCommentTypeId,
          // An agent is never an internal reader. It is a delegate working one
          // task, not a member of the business, so it is shown what an external
          // reader is shown — the client comments in the fields the catalogue
          // marks `shared` — and internal notes are absent from its answer
          // rather than hidden in it (I09).
          internal: false,
        });
        return task === undefined
          ? NOT_FOUND()
          : { recordId: task.id, revision: task.revision, detail: { task } };
      },
    },
  ],
  [
    'task.comment',
    {
      authority: 'record',
      subjectTask: 'record',
      replay: 'reauthorise',
      // The person command path answers a non-string record id as a missing
      // record (`prepare.ts`, `lockTask`), so this one does too.
      operands: recordIdOperand(() => refuseNotFound()),
      serve: serveComment,
    },
  ],
  [
    'task.decide',
    {
      authority: 'decision',
      replay: 'reauthorise',
    },
  ],
  [
    'session.capabilities',
    {
      authority: 'purpose',
      replay: 'capabilities',
      identifiers: READ_CATALOGUE['session.capabilities'].identifiers,
      // An agent holds no grants of its own -- `identity/agent-login.ts`
      // confers nothing at all -- so this is not the person answer with a
      // different subject in it. What the agent has is a purpose, and the
      // pairs reported are that purpose as the delegating person's grants
      // still cover it on the picked-up task, read now (`capabilitiesOf`).
      serve: async (tx, { session }, _operands, delegation) => ({
        recordId: null,
        revision: null,
        detail: { ...(await capabilitiesOf(tx, session, delegation)) },
      }),
    },
  ],
]);
