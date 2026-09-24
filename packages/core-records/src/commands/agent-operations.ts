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
import { readTaskDetail } from '../reads/tasks.ts';
import { businessKeyOf, type AgentCapabilities, type Capability } from '../reads/capabilities.ts';
import { readTaskSpine } from './context.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import { declarationOf, type CommandName } from './surface.ts';
import { handbackLease, pickupReservation } from './tasks-runtime.ts';
import { heartbeatLease } from './tasks-controls.ts';
import { writeTaskComment } from './tasks-comment.ts';
import { refused, type HandlerOutcome, type Refused } from './outcome.ts';
import { claimedSystemFields, SYSTEM_OWNED_FIXES } from './prepare.ts';
import { retainLateHandback } from './agent-late-handback.ts';

/**
 * What an agent sends.
 *
 * The credential is **not** in it. It arrives beside the request the way the
 * bearer token does, because it is a credential rather than a field: a payload
 * field is something the command is about, and a body that carried its own
 * authority would be a body that could be logged, replayed into a register row
 * and compared by a digest.
 */
export interface AgentRequest {
  readonly command: CommandName;
  readonly operationId: string;
  readonly [field: string]: unknown;
}

/** One agent call: who is calling, under what credential, asking what. */
export interface AgentCall {
  readonly session: AgentSession;
  readonly credential: string | undefined;
  readonly request: AgentRequest;
}

/** The operands an agent command takes beyond its identifiers, parsed rather than coerced. */
export interface AgentOperands {
  readonly leaseSeconds?: number;
  readonly report?: Readonly<Record<string, unknown>>;
}

export interface AgentOperation {
  /**
   * The check `authorise` (`agent-authority.ts`) asks.
   *
   * `beforePickup` is the pair an agent login reaches holding nothing;
   * `purpose` is `read` on the delegation's own purpose record; `decision` is
   * L4's `decideAsAgent`, and a decision named as one when no credential is
   * presented; `record` is the operation's own collection and action on the
   * task the call is about.
   */
  readonly authority: 'beforePickup' | 'purpose' | 'decision' | 'record';
  /** Where a `record` or `decision` check finds its task: the lease the body names, or the record. */
  readonly subjectTask: 'lease' | 'record';
  /** The operands read before any authority, after the system-owned fields. */
  readonly operands?: (request: AgentRequest) => AgentOperands | Refused;
  /** What it does, under the delegation `authorise` resolved (none before a pickup). */
  readonly serve: (
    tx: TenantQuery,
    call: AgentCall,
    operands: AgentOperands,
    delegation: Delegation | undefined,
  ) => Promise<HandlerOutcome>;
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

export const UUID: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** What a delegated agent may write a comment in: its team's notes, not the client's thread. */
const AGENT_AUDIENCES: ReadonlySet<string> = new Set(['internal']);

const LEASE_SECONDS_FIXES: readonly string[] = [
  'Name a whole, positive number of seconds, or leave leaseSeconds out for the default.',
];
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
function leaseSecondsOperand(request: AgentRequest): AgentOperands | Refused {
  if (!('leaseSeconds' in request)) return {};
  const seconds = request['leaseSeconds'];
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['leaseSeconds'], LEASE_SECONDS_FIXES), {
      leaseSeconds: seconds,
    });
  }
  return { leaseSeconds: seconds };
}

function handbackOperands(request: AgentRequest): AgentOperands | Refused {
  let operands: AgentOperands = {};
  if ('report' in request) {
    const report = request['report'];
    if (typeof report !== 'object' || report === null || Array.isArray(report)) {
      return refused(refuseCommand('FIELD_VALUE_INVALID', ['report'], REPORT_FIXES), { report });
    }
    operands = { report: report as Readonly<Record<string, unknown>> };
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
  delegation: Delegation | undefined,
): Promise<AgentCapabilities> {
  const held = heldBy(delegation, 'session.capabilities');
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

/**
 * The delegation an operation past the pre-pickup pair runs under. `authorise`
 * refuses every such call that resolves none, so its absence here is a fault.
 */
function heldBy(delegation: Delegation | undefined, command: CommandName): Delegation {
  if (delegation === undefined) {
    throw new Error(`agent-operations: ${command} was served without a delegation`);
  }
  return delegation;
}

const NOT_FOUND = (): Refused => ({
  refusal: refuseCommand('NOT_FOUND', [], ['Check the identifier you were given.']),
});

async function serveComment(tx: TenantQuery, { session, request }: AgentCall) {
  // The agent's own picked-up task: `authorise` has already held the
  // delegation's purpose scope to this record and its `comment` action to
  // the delegating person's live grant. The task is locked here as the
  // person path's envelope locks it, and the comment commits with its own
  // identity. `internal` only: a note to the team, never text a client
  // reads without a person having written it.
  const recordId = request['recordId'];
  const rows =
    typeof recordId === 'string' && UUID.test(recordId)
      ? await tx.query<{ readonly id: string; readonly revision: string }>(
          `select id, revision::text as revision from public.records
            where business_id = $1 and id = $2 and deleted_at is null for update`,
          [tx.businessId, recordId],
        )
      : [];
  const task = rows[0];
  if (task === undefined) return NOT_FOUND();
  const spine = await readTaskSpine(tx);
  return await writeTaskComment(
    tx,
    {
      commentTypeId: spine.taskCommentTypeId,
      declaration: declarationOf('task.comment') as NonNullable<ReturnType<typeof declarationOf>>,
      target: { id: task.id, revision: Number(task.revision) },
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
  delegation: Delegation | undefined,
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
    session.actorId,
    heldBy(delegation, 'task.heartbeat').id,
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
      subjectTask: 'record',
      replay: 'reauthorise',
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
      subjectTask: 'record',
      replay: 'pickup',
      operands: leaseSecondsOperand,
      serve: async (tx, { session, request }, operands) =>
        await pickupReservation(
          tx,
          declarationOf('task.pickup')?.collection ?? 'task',
          session.actorId,
          {
            reservationId: String(request['reservationId'] ?? ''),
            ...(operands.leaseSeconds === undefined ? {} : { leaseSeconds: operands.leaseSeconds }),
          },
        ),
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
            leaseId: String(request['leaseId'] ?? ''),
            fence: Number(request['fence']),
            outcome: String(request['outcome'] ?? ''),
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
      operands: leaseSecondsOperand,
      serve: serveHeartbeat,
    },
  ],
  [
    'task.read',
    {
      authority: 'record',
      subjectTask: 'record',
      replay: 'reauthorise',
      serve: async (tx, { request }) => {
        const spine = await readTaskSpine(tx);
        const task = await readTaskDetail(tx, spine.taskTypeId, String(request['recordId'] ?? ''), {
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
    { authority: 'record', subjectTask: 'record', replay: 'reauthorise', serve: serveComment },
  ],
  [
    'task.decide',
    {
      authority: 'decision',
      subjectTask: 'record',
      replay: 'reauthorise',
      // `authorise` always refuses a decision, so this is never reached; it is
      // the refusal the old `serve` switch gave an operation it did not serve.
      serve: async (_tx, { request }) =>
        await Promise.resolve({
          refusal: refuseCommand(
            'DELEGATION_EXCLUDES_OPERATION',
            [request.command],
            ['Every other operation belongs to a person.'],
          ),
        }),
    },
  ],
  [
    'session.capabilities',
    {
      authority: 'purpose',
      subjectTask: 'record',
      replay: 'capabilities',
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
