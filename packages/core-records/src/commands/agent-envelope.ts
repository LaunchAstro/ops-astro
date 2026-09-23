// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's own way in. A second entry point, not a second surface.
//
// A person's login, an agent's login and a delegation credential are three
// credentials and three things (AUTHORITY.md). The person path resolves the
// first through `identity/login-resolution.ts` and asks `grants` what the
// person holds; this path resolves the second through
// `identity/agent-login.ts` — which confers **nothing at all** — and asks
// `authority/checkDelegatedAuthority` what the third permits, on every call,
// against the delegating person's grants as they are right now.
//
// **Asking what it may do.** `session.capabilities` is reachable on this
// prefix under a live delegation, and its answer is the agent's own, not the
// delegating person's: its own acting identity, the business key, the purpose
// its delegation is bounded to and the authority the two pre-pickup operations
// take. An agent holds no grants of its own -- see below -- so reporting the
// delegating person's here would be reporting somebody else's authority as the
// agent's.
//
// **The two operations before there is anything to delegate.** An agent that
// has not picked work up holds no delegation, so there is nothing to intersect
// its call with. It may do exactly two things: read `task.queue` and call
// `task.pickup`. Every other exported operation is refused
// `DELEGATION_EXCLUDES_OPERATION`, and `task.decide`
// `DELEGATION_EXCLUDES_DECISION` (minimum contract 8.2 case 9, ledger I12):
// with no credential presented the call is outside what an agent login may do
// at all, which is an exclusion, not a lapsed delegation. A credential that is
// presented and does not answer to a live delegation is still
// `DELEGATION_NOT_LIVE`, told apart from "expired", "revoked" and "settled" by
// nothing, deliberately, because telling them apart tells a caller holding a
// stolen credential which of those it is.
//
// **After pickup, the one-task ceiling.** `pickup` mints a delegation whose
// `purposeScope` is the picked-up task's record id, and every call here is
// checked against exactly that scope. A call on a sibling task is
// `DELEGATION_OUT_OF_PURPOSE` — not `NOT_FOUND`, because the task is really
// there and the agent really may not reach it — and so is a call on the right
// task with an action the purpose does not carry. `task.decide` is refused
// `DELEGATION_EXCLUDES_DECISION` by L4's `decideAsAgent`, which asks L2 and
// returns L2's answer rather than inventing a runtime code for it.
//
// **What this path does not duplicate.** The repeat-request identity, the
// audit row and the refusal's rollback are the same mechanisms the person
// envelope owns, reached through the same `register-store.ts` and
// `audit.ts`. What it cannot reuse is `runCommand` itself: that takes a
// `Session`, which has a `personId`, and an `AgentSession` has no `personId`
// field at all. Not null — absent. Synthesising one so the person envelope
// would accept an agent is exactly the collapse the identity model exists to
// prevent, and it would put the delegating person's identity on the agent's
// audit rows.

import type { BusinessId, Database, TenantQuery } from '../tenancy/database.ts';
import type { VerifiedSubject } from '../identity/verified-subject.ts';
import { refuseExpiredSession, resolveAgentLogin } from '../identity/agent-login.ts';
import type { AgentSession } from '../identity/agent-login.ts';
import {
  checkDelegatedAuthority,
  digestOf,
  resolveDelegation,
  type Delegation,
} from '../authority/delegations.ts';
import { DERIVED_SCHEME, LEGACY_SCHEME } from '../authority/credential-keys.ts';
import { delegationCredentialKeys } from './runtime-config.ts';
import { decideAsAgent } from '../../../core-runtime/src/index.ts';
import { readQueue } from '../reads/queue.ts';
import { readTaskDetail } from '../reads/tasks.ts';
import { businessKeyOf, type AgentCapabilities } from '../reads/capabilities.ts';
import { writeAuditEvent } from './audit.ts';
import { payloadDigest } from './digest.ts';
import { readTaskSpine } from './context.ts';
import {
  asCallerVisible,
  fromAgentIdentity,
  isCommandRefusal,
  refuseCommand,
  type CommandRefusal,
} from './refusal.ts';
import { declarationOf, type CommandName } from './surface.ts';
import {
  OPERATION_ID,
  lookupAttempt,
  registerAttempt,
  type CommandHandle,
  type CommandResult,
} from './register-store.ts';
import { fromRuntime, handbackLease, pickupReservation } from './tasks-runtime.ts';
import { heartbeatLease } from './tasks-controls.ts';
import { writeTaskComment } from './tasks-comment.ts';
import { isRefused, refused, type HandlerOutcome, type Refused } from './outcome.ts';
import { claimedSystemOwnedFields, SYSTEM_OWNED_FIXES } from './prepare.ts';

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

/**
 * The two operations an agent may reach before it holds anything.
 *
 * `session.capabilities` is not a third: before a pickup it is refused
 * `DELEGATION_EXCLUDES_OPERATION` like every other operation outside this set
 * (minimum contract 8.2 case 9). Under a live delegation it answers the
 * delegation's purpose.
 */
export const BEFORE_PICKUP: ReadonlySet<CommandName> = new Set(['task.queue', 'task.pickup']);

/** What an agent may reach at all, delegation or not. */
export const AGENT_SURFACE: ReadonlySet<CommandName> = new Set([
  'task.queue',
  'task.pickup',
  'task.handback',
  'task.heartbeat',
  'task.read',
  'task.comment',
  'task.decide',
  'session.capabilities',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** What a delegated agent may write a comment in: its team's notes, not the client's thread. */
const AGENT_AUDIENCES: ReadonlySet<string> = new Set(['internal']);

const NO_DELEGATION_FIXES: readonly string[] = [
  'Present the credential the pickup handed you.',
  'Before a pickup an agent login may only read task.queue and call task.pickup.',
];

const PRE_PICKUP_DECISION_FIXES: readonly string[] = [
  'A person decides, with their own credential.',
  ...NO_DELEGATION_FIXES.slice(1),
];

export async function executeAgentCommand(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject | 'expired',
  credential: string | undefined,
  request: AgentRequest,
): Promise<CommandResult> {
  // An expired bearer is answered before the database is opened. It is its own
  // code rather than `AUTH_NO_AGENT_IDENTITY` because it is the re-login path:
  // a caller that cannot tell "your session ended" from "you are not an agent
  // here" cannot tell a door it can open from one it cannot.
  if (presented === 'expired') return asCallerVisible(fromAgentIdentity(refuseExpiredSession()));

  return await database.withBusiness(businessId, async (tx) => {
    const session = await resolveAgentLogin(tx, presented);
    // No actor, so no audit event can be attributed. `resolveAgentLogin` has
    // already written the authentication attempt, which is the record that
    // exists for exactly this case (AUTHORITY.md, "every attempt at the door").
    if ('refused' in session) return asCallerVisible(fromAgentIdentity(session));
    return await runAgentCommand(tx, session, credential, request);
  });
}

/**
 * What the agent prefix puts on the wire for a result, which is the handle
 * except for the one read the person prefix also serves.
 *
 * `session.capabilities` answers flattened beside `ok` on the person prefix,
 * which is the shape the mounted app reads (`reads/capabilities.ts`,
 * `SessionCapabilities`). Here the envelope nests every payload under
 * `detail`, so the same read arrived in two shapes and a client had to know
 * which prefix it was on (L5-PROOFS handback, "Defects" 4). It is flattened
 * here, at the wire, rather than in `serve`: the register row keeps the handle
 * every other agent answer is stored as, so a replay reads the same record and
 * is shaped the same way on the way out.
 */
export function agentAnswer(command: string, result: unknown): unknown {
  if (command !== 'session.capabilities') return result;
  if (typeof result !== 'object' || result === null || isCommandRefusal(result)) return result;
  const detail = (result as Partial<CommandHandle>).detail;
  return typeof detail === 'object' && detail !== null ? { ok: true, ...detail } : result;
}

async function runAgentCommand(
  tx: TenantQuery,
  session: AgentSession,
  credential: string | undefined,
  request: AgentRequest,
): Promise<CommandResult> {
  const digest = payloadDigest(comparable(request));
  const declaration = declarationOf(request.command);
  if (declaration === undefined || !AGENT_SURFACE.has(request.command)) {
    return await settle(
      tx,
      session,
      request,
      digest,
      refuseCommand(
        'DELEGATION_EXCLUDES_OPERATION',
        [request.command],
        [
          'An agent reaches the queue, a pickup, its own task and a handback.',
          'Every other operation belongs to a person.',
        ],
      ),
      true,
    );
  }

  if (!OPERATION_ID.test(request.operationId)) {
    return await settle(
      tx,
      session,
      request,
      digest,
      refuseCommand(
        'OPERATION_ID_REQUIRED',
        [],
        [
          'Send an operation_id: 8 to 200 characters of letters, digits, dot, colon, dash or underscore.',
        ],
      ),
      true,
    );
  }

  // The same register the person path uses, keyed on the agent's own actor, so
  // a pickup retried after a lost response replays the lease it already holds
  // instead of claiming a second one.
  const seen = await lookupAttempt(tx, session.actorId, request.operationId);
  if (seen !== undefined) {
    if (seen.payload_digest !== digest) {
      return await settle(
        tx,
        session,
        request,
        digest,
        refuseCommand(
          'OPERATION_ID_REUSED',
          [seen.command],
          ['This identity already carries a different request. Use a new operation_id.'],
        ),
        true,
      );
    }
    const replayed = seen.result as unknown as CommandResult;
    // A stored refusal carries nothing protected. A stored success is released
    // only to the rights held now (TRANSACTION-CONTRACT: "Authorise the
    // replay's read under current rights before returning protected
    // content"), so a read repeated after its grant or delegation went answers
    // today's refusal rather than yesterday's task. The register row stays as
    // it was: the operation happened, and nothing here repeats it.
    //
    // A pickup is the one replay that hands something back beyond the receipt:
    // the credential the lost response carried, derived again once the
    // current rights and the receipt's own lease have been checked.
    const released: CommandResult | undefined = isCommandRefusal(replayed)
      ? undefined
      : request.command === 'task.pickup'
        ? await replayPickup(tx, session, replayed)
        : await authoriseReplay(tx, session, credential, request, replayed);
    if (released !== undefined && isCommandRefusal(released)) {
      const visible = asCallerVisible(released);
      await writeAuditEvent(tx, {
        actorId: session.actorId,
        command: request.command,
        operationId: request.operationId,
        outcome: 'refused',
        refusalCode: visible.code,
        subjectRecordId: null,
        payloadDigest: digest,
      });
      return visible;
    }
    await writeAuditEvent(tx, {
      actorId: session.actorId,
      command: request.command,
      operationId: request.operationId,
      outcome: 'replayed',
      refusalCode: isCommandRefusal(replayed) ? replayed.code : null,
      subjectRecordId: isCommandRefusal(replayed) ? null : replayed.recordId,
      payloadDigest: digest,
    });
    return released ?? replayed;
  }

  // The request's own shape, before any authority is read: a system-owned
  // field (D06, the person path's own classifier) and then each operand the
  // command takes. Neither tells the caller anything about the business.
  const operands = parseOperands(request);
  if ('refusal' in operands) {
    return await settle(tx, session, request, digest, operands.refusal, false, operands.attempted);
  }

  const authorised = await authorise(tx, session, credential, request);
  if (authorised !== undefined) return await settle(tx, session, request, digest, authorised);

  await tx.query('savepoint agent_work');
  const outcome = await serve(tx, session, credential, request, operands);
  // A refusal rolls back whatever reached the database on the way to it, for
  // the same reason and by the same mechanism as the person envelope's.
  await tx.query(
    // A refusal rolls back, except the one that kept something on purpose:
    // `Refused.retains` is set by a handler that wrote a row the contract
    // retains alongside the refusal, and rolling back would discard it.
    isRefused(outcome) && outcome.retains !== true
      ? 'rollback to savepoint agent_work'
      : 'release savepoint agent_work',
  );
  if (isRefused(outcome)) {
    return await settle(tx, session, request, digest, outcome.refusal, false, outcome.attempted);
  }

  const handle: CommandHandle = {
    command: request.command,
    recordId: outcome.recordId,
    revision: outcome.revision,
    detail: outcome.detail,
  };
  await registerAttempt(tx, {
    operationId: request.operationId,
    command: request.command,
    actorId: session.actorId,
    digest,
    result: storable(handle),
    recordId: outcome.recordId,
  });
  await writeAuditEvent(tx, {
    actorId: session.actorId,
    command: request.command,
    operationId: request.operationId,
    outcome: 'applied',
    subjectRecordId: outcome.recordId,
    payloadDigest: digest,
  });
  return handle;
}

/**
 * The delegation check, in the order AUTHORITY.md puts it.
 *
 * Returns the refusal, or nothing when the call may go ahead. The pre-pickup
 * pair short-circuits it: there is no delegation to intersect with, and the
 * two operations they are bounded to are the ones that cannot touch a task's
 * own data — the queue names reservations and a pickup claims one.
 */
async function authorise(
  tx: TenantQuery,
  session: AgentSession,
  credential: string | undefined,
  request: AgentRequest,
): Promise<CommandRefusal | undefined> {
  if (BEFORE_PICKUP.has(request.command)) return undefined;

  // No credential is an agent login before any pickup, and it reaches the two
  // operations above and nothing else (minimum contract 8.2 case 9): an
  // exclusion, named for what was asked, and a decision named as one.
  if (credential === undefined || credential === '') {
    return request.command === 'task.decide'
      ? refuseCommand('DELEGATION_EXCLUDES_DECISION', [request.command], PRE_PICKUP_DECISION_FIXES)
      : refuseCommand('DELEGATION_EXCLUDES_OPERATION', [request.command], NO_DELEGATION_FIXES);
  }
  const resolved = await resolveDelegation(tx, session.actorId, credential);
  if (!resolved.ok) return fromRuntime(resolved.refusal);
  const delegation = resolved.value;

  // Under a live delegation the agent may ask what it may do: the answer is
  // that delegation's purpose, which is not a grant on any collection.
  if (request.command === 'session.capabilities') return undefined;

  const taskId = await subjectTaskId(tx, delegation, request);

  if (request.command === 'task.decide') {
    // L4 asks L2 and returns L2's answer. It cannot succeed: `DelegableAction`
    // excludes `decide`, the check refuses it first, and a delegation carrying
    // it cannot be written at all (`delegations_never_decide`).
    const excluded = await decideAsAgent(tx, delegation, {
      collection: 'task',
      taskId,
    });
    return fromRuntime(excluded.ok ? unreachable() : excluded.refusal);
  }

  const declaration = declarationOf(request.command);
  const decision = await checkDelegatedAuthority(tx, delegation, {
    collection: declaration?.collection ?? 'task',
    action: declaration?.action ?? 'read',
    // Always the record, never the business: a business-scoped request under a
    // delegation is outside its purpose by construction, and the one-task
    // ceiling is the whole of what `purposeScope` buys.
    scope: { kind: 'record', id: taskId },
  });
  return decision.ok ? undefined : fromRuntime(decision.refusal);
}

function unreachable(): never {
  throw new Error('agent-envelope: decideAsAgent permitted a decision');
}

/**
 * The task a call is about.
 *
 * A handback names a lease rather than a task, so the task is read from the
 * lease before the authority check rather than taken from the body: an agent
 * that could name the task its handback is "about" could satisfy the one-task
 * check with its own task while settling somebody else's lease. Anything that
 * resolves to nothing falls back to the delegation's own scope, which then
 * either matches — and the operation refuses on its own terms — or does not.
 */
async function subjectTaskId(
  tx: TenantQuery,
  delegation: Delegation,
  request: AgentRequest,
): Promise<string> {
  if (
    (request.command === 'task.handback' || request.command === 'task.heartbeat') &&
    typeof request['leaseId'] === 'string'
  ) {
    const rows = await tx.query<{ readonly task_id: string }>(
      `select task_id from public.leases where business_id = $1 and id = $2`,
      [tx.businessId, request['leaseId']],
    );
    return rows[0]?.task_id ?? delegation.purposeScope.id;
  }
  const named = request['recordId'];
  return typeof named === 'string' ? named : delegation.purposeScope.id;
}

async function serve(
  tx: TenantQuery,
  session: AgentSession,
  credential: string | undefined,
  request: AgentRequest,
  operands: AgentOperands,
): Promise<HandlerOutcome> {
  switch (request.command) {
    case 'session.capabilities': {
      // An agent holds no grants of its own -- `identity/agent-login.ts`
      // confers nothing at all -- so this is not the person answer with a
      // different subject in it. Handing back the delegating person's grants
      // here would report somebody else's authority as the agent's, which is
      // the collapse this whole entry point exists to prevent. What the agent
      // has is a purpose and a floor: the task its delegation is bounded to,
      // and the two operations it may reach holding nothing.
      const resolved =
        credential === undefined || credential === ''
          ? undefined
          : await resolveDelegation(tx, session.actorId, credential);
      const capabilities: AgentCapabilities = {
        agentActorId: session.actorId,
        businessKey: await businessKeyOf(tx),
        purposeScope: resolved !== undefined && resolved.ok ? resolved.value.purposeScope : null,
        // The authority the pre-pickup pair takes, read off their own
        // declarations so this list cannot drift from `BEFORE_PICKUP`.
        grants: [...BEFORE_PICKUP]
          .toSorted()
          .map((name) => ({
            collection: declarationOf(name)?.collection ?? 'task',
            action: declarationOf(name)?.action ?? 'read',
          }))
          .filter(
            (pair, index, all) =>
              all.findIndex(
                (other) => other.collection === pair.collection && other.action === pair.action,
              ) === index,
          ),
      };
      return { recordId: null, revision: null, detail: { ...capabilities } };
    }
    case 'task.queue':
      return { recordId: null, revision: null, detail: { queue: await readQueue(tx) } };
    case 'task.pickup':
      return await pickupReservation(
        tx,
        declarationOf('task.pickup')?.collection ?? 'task',
        session.actorId,
        {
          reservationId: String(request['reservationId'] ?? ''),
          ...(operands.leaseSeconds === undefined ? {} : { leaseSeconds: operands.leaseSeconds }),
        },
      );
    case 'task.handback':
      return await handbackLease(
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
      );
    case 'task.comment': {
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
      if (task === undefined) {
        return {
          refusal: refuseCommand('NOT_FOUND', [], ['Check the identifier you were given.']),
        };
      }
      const spine = await readTaskSpine(tx);
      return await writeTaskComment(
        tx,
        {
          commentTypeId: spine.taskCommentTypeId,
          declaration: declarationOf('task.comment') as NonNullable<
            ReturnType<typeof declarationOf>
          >,
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
    case 'task.heartbeat': {
      // `authorise` resolved this credential a moment ago in this transaction;
      // it is resolved again for its id rather than threaded through, the way
      // `session.capabilities` does above.
      const resolved = await resolveDelegation(tx, session.actorId, credential ?? '');
      if (!resolved.ok) return { refusal: fromRuntime(resolved.refusal) };
      return await heartbeatLease(
        tx,
        {
          leaseId: request['leaseId'],
          fence: request['fence'],
          ...(operands.leaseSeconds === undefined ? {} : { leaseSeconds: operands.leaseSeconds }),
        },
        session.actorId,
        resolved.value.id,
      );
    }
    case 'task.read': {
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
        ? { refusal: refuseCommand('NOT_FOUND', [], ['Check the identifier you were given.']) }
        : { recordId: task.id, revision: task.revision, detail: { task } };
    }
    default:
      return {
        refusal: refuseCommand(
          'DELEGATION_EXCLUDES_OPERATION',
          [request.command],
          ['Every other operation belongs to a person.'],
        ),
      };
  }
}

/** The register row and the audit row for a refusal, then the caller's version. */
async function settle(
  tx: TenantQuery,
  session: AgentSession,
  request: AgentRequest,
  digest: string,
  refusal: CommandRefusal,
  withoutIdentity = false,
  attempted?: Readonly<Record<string, unknown>>,
): Promise<CommandRefusal> {
  const visible = asCallerVisible(refusal);
  if (!withoutIdentity) {
    await registerAttempt(tx, {
      operationId: request.operationId,
      command: request.command,
      actorId: session.actorId,
      digest,
      result: visible,
      recordId: null,
    });
  }
  await writeAuditEvent(tx, {
    actorId: session.actorId,
    command: request.command,
    operationId: withoutIdentity ? null : request.operationId,
    outcome: 'refused',
    refusalCode: refusal.code,
    subjectRecordId: null,
    payloadDigest: digest,
    attempted: attempted ?? null,
  });
  return visible;
}

/** Everything the register compares, which is the request without its identity. */
function comparable(request: AgentRequest): Readonly<Record<string, unknown>> {
  const { operationId: _identity, ...rest } = request;
  return rest;
}

/** The operands an agent command takes beyond its identifiers, parsed rather than coerced. */
interface AgentOperands {
  readonly leaseSeconds?: number;
  readonly report?: Readonly<Record<string, unknown>>;
}

const LEASE_SECONDS_FIXES: readonly string[] = [
  'Name a whole, positive number of seconds, or leave leaseSeconds out for the default.',
];
const REPORT_FIXES: readonly string[] = [
  'Send report as an object of named values, or leave it out.',
];

/**
 * The request's system-owned fields refused, then its operands read.
 *
 * A present operand of the wrong shape is refused by name. It is never the
 * default in disguise, and a report is never dropped or turned into an object
 * with numeric keys: a caller that sent something and got the default back
 * would believe the server had read what it sent. Absent keeps the default.
 * Range belongs to the handler (`pickupReservation`, `heartbeatLease`), which
 * already refuses an out-of-range lease in the same code.
 */
function parseOperands(request: AgentRequest): AgentOperands | Refused {
  const claimed = claimedSystemOwnedFields(request);
  if (claimed !== undefined) {
    return refused(
      refuseCommand('FIELD_NOT_WRITABLE', claimed.keys, SYSTEM_OWNED_FIXES),
      claimed.values,
    );
  }
  let operands: AgentOperands = {};
  if (
    (request.command === 'task.pickup' || request.command === 'task.heartbeat') &&
    'leaseSeconds' in request
  ) {
    const seconds = request['leaseSeconds'];
    if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0) {
      return refused(refuseCommand('FIELD_VALUE_INVALID', ['leaseSeconds'], LEASE_SECONDS_FIXES), {
        leaseSeconds: seconds,
      });
    }
    operands = { leaseSeconds: seconds };
  }
  if (request.command === 'task.handback' && 'report' in request) {
    const report = request['report'];
    if (typeof report !== 'object' || report === null || Array.isArray(report)) {
      return refused(refuseCommand('FIELD_VALUE_INVALID', ['report'], REPORT_FIXES), { report });
    }
    operands = { report: report as Readonly<Record<string, unknown>> };
  }
  return operands;
}

/**
 * The note a replayed pickup carries in place of its credential, when its
 * delegation predates derivation (`legacy-random`) and nothing can give the
 * credential back.
 */
export const CREDENTIAL_NOT_REPLAYED = 'CREDENTIAL_NOT_REPLAYED';

/**
 * The handle as the register keeps it: without the delegation credential.
 *
 * The credential is "stored by hash" (TRANSACTION-CONTRACT) and
 * `delegations.credential_hash` is that store. A register row holding it in
 * the clear would be a second, readable copy, and a replay would hand it to
 * whoever repeated the operation id. So the row keeps every handle and a null
 * credential; `replayPickup` derives the credential again rather than reading
 * it from anywhere.
 */
function storable(handle: CommandHandle): CommandHandle {
  if (!('credential' in handle.detail)) return handle;
  return { ...handle, detail: { ...handle.detail, credential: null } };
}

const PICKUP_REPLAY_FIXES: readonly string[] = [
  'The work this pickup claimed is no longer yours to resume.',
  'Re-read the queue.',
];

interface PickupBindingRow {
  readonly credential_scheme: string;
  readonly credential_key_id: string | null;
  readonly credential_hash: string;
  readonly lease_live: boolean;
  readonly approval_current: boolean;
}

/**
 * A pickup's replay, which is the case where the agent lost the answer that
 * carried its credential and so has none to present (root ruling 6: the
 * deliberate exception to "no credential, no call").
 *
 * In order, and every step reads the rows as they are now:
 *
 * 1. The delegation the receipt names is still live and still this agent's.
 * 2. The delegating person's current grants still cover the pickup's purpose.
 * 3. The receipt's lease, reservation, attempt and delegation are still bound
 *    to one another, to this agent, and to the receipt's task and version. The
 *    lease is live and unexpired, the hold is held, and the approval behind it
 *    is still current.
 * 4. Only then is the credential derived under the delegation's pinned scheme
 *    and key id, and its digest compared with the one stored at mint.
 *
 * A missing key or a digest that does not match is a closed failure. The
 * receipt is not rewritten, nothing is minted in its place, and no lease,
 * hold, expiry or delegation is touched. A `legacy-random` delegation answers
 * its receipt with no credential and says why, because a digest cannot give
 * random bytes back.
 */
async function replayPickup(
  tx: TenantQuery,
  session: AgentSession,
  stored: CommandHandle,
): Promise<CommandResult> {
  const detail = stored.detail;
  const named = (key: string): string => {
    const value = detail[key];
    return typeof value === 'string' && UUID.test(value) ? value : '';
  };
  const delegationId = named('delegationId');
  const held = await heldDelegation(tx, session, 'live', delegationId);
  if (held === undefined) return refuseCommand('DELEGATION_NOT_LIVE', [], PICKUP_REPLAY_FIXES);

  const declaration = declarationOf('task.pickup');
  const decision = await checkDelegatedAuthority(tx, held, {
    collection: declaration?.collection ?? 'task',
    action: declaration?.action ?? 'write',
    scope: held.purposeScope,
  });
  if (!decision.ok) return fromRuntime(decision.refusal);

  const rows = await tx.query<PickupBindingRow>(
    `select d.credential_scheme, d.credential_key_id, d.credential_hash,
            (l.state = 'live' and l.expires_at > now() and res.state = 'held') as lease_live,
            (g.state = 'approved' and lin.state = 'live' and ver.superseded_at is null)
              as approval_current
       from public.leases l
       join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
       join public.reservations res on res.business_id = l.business_id and res.lease_id = l.id
       join public.attempts att
         on att.business_id = l.business_id and att.reservation_id = res.id and att.lease_id = l.id
       join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
       join public.proposal_versions ver
         on ver.business_id = res.business_id and ver.id = res.version_id
       join public.proposal_lineages lin
         on lin.business_id = res.business_id and lin.id = run.lineage_id
       join public.gates g on g.business_id = res.business_id and g.version_id = res.version_id
      where l.business_id = $1 and l.id = $2 and d.id = $3 and res.id = $4 and att.id = $5
        and l.holder_actor_id = $6 and d.agent_actor_id = $6
        and l.task_id = $7 and res.version_id = $8`,
    [
      tx.businessId,
      named('leaseId'),
      delegationId,
      named('reservationId'),
      named('attemptId'),
      session.actorId,
      named('taskId'),
      named('versionId'),
    ],
  );
  const bound = rows[0];
  if (bound === undefined) return refuseCommand('LEASE_NOT_OWNED', [], PICKUP_REPLAY_FIXES);
  if (!bound.lease_live) return refuseCommand('LEASE_EXPIRED', [], PICKUP_REPLAY_FIXES);
  if (!bound.approval_current) {
    return refuseCommand('RESERVATION_NOT_CLAIMABLE', [], PICKUP_REPLAY_FIXES);
  }

  // `credential` is read by the spread below and then replaced; the note, if
  // an older row carries one, does not survive into a derived answer.
  const { credentialNote: _note, ...handles } = detail;
  if (bound.credential_scheme === LEGACY_SCHEME) {
    return {
      ...stored,
      detail: { ...handles, credential: null, credentialNote: CREDENTIAL_NOT_REPLAYED },
    };
  }
  const keyId = bound.credential_key_id;
  const keys = delegationCredentialKeys();
  const credential =
    bound.credential_scheme !== DERIVED_SCHEME || keyId === null || !keys.ok
      ? undefined
      : keys.keys.derive(keyId, {
          businessId: tx.businessId,
          agentActorId: session.actorId,
          delegationId,
        });
  if (credential === undefined) {
    return refuseCommand(
      'DEPENDENCY_NOT_LANDED',
      ['task.pickup', `delegation credential key ${keyId ?? 'unrecorded'}`],
      [
        'This deployment does not hold the key this delegation was minted under.',
        'Restore that key; the pickup is unchanged and replays once it is back.',
      ],
    );
  }
  if (digestOf(credential) !== bound.credential_hash) {
    return refuseCommand(
      'DEPENDENCY_NOT_LANDED',
      ['task.pickup', 'delegation credential integrity'],
      [
        'The credential derived for this pickup does not match the one it was issued.',
        'Nothing was reissued. Restore the key this delegation was minted under.',
      ],
    );
  }
  return { ...stored, detail: { ...handles, credential } };
}

/**
 * Whether a stored success may be released to the rights held now.
 *
 * Most operations answer to the same check a fresh call does. A pickup has its
 * own path (`replayPickup`). A handback cannot answer to the fresh check
 * either: it settles its own delegation, so the credential that made it no
 * longer resolves as live. Its receipt is released to that same credential,
 * for that delegation's own lease, while the delegation was settled rather
 * than revoked and has not expired, and the person's grants still cover it.
 * With no credential at all, a handback replay is what any bare agent call
 * outside the queue and pickup is (root ruling 6): an exclusion, with nothing
 * of the receipt in it.
 *
 * Nothing here repeats anything. The refusal comes back, not the stored
 * detail, when the rights are gone.
 */
async function authoriseReplay(
  tx: TenantQuery,
  session: AgentSession,
  credential: string | undefined,
  request: AgentRequest,
  stored: CommandHandle,
): Promise<CommandRefusal | undefined> {
  if (request.command !== 'task.handback') {
    return await authorise(tx, session, credential, request);
  }
  if (credential === undefined || credential === '') {
    return refuseCommand('DELEGATION_EXCLUDES_OPERATION', [request.command], NO_DELEGATION_FIXES);
  }
  const held = await heldDelegation(
    tx,
    session,
    'settled',
    String(stored.detail['leaseId'] ?? ''),
    credential,
  );
  if (held === undefined) return refuseCommand('DELEGATION_NOT_LIVE', [], NO_DELEGATION_FIXES);
  const declaration = declarationOf(request.command);
  const decision = await checkDelegatedAuthority(tx, held, {
    collection: declaration?.collection ?? 'task',
    action: declaration?.action ?? 'write',
    scope: held.purposeScope,
  });
  return decision.ok ? undefined : fromRuntime(decision.refusal);
}

interface HeldDelegationRow {
  readonly id: string;
  readonly agent_actor_id: string;
  readonly delegate_person_id: string;
  readonly minted_by_actor_id: string;
  readonly purpose: string;
  readonly collections: readonly string[];
  readonly actions: Delegation['actions'];
  readonly purpose_scope_id: string;
  readonly expires_at: Date;
}

/**
 * This agent's unexpired, unrevoked delegation: `live` by its own id, or
 * `settled` through the lease it settled and the credential it was minted with.
 */
async function heldDelegation(
  tx: TenantQuery,
  session: AgentSession,
  state: 'live' | 'settled',
  key: string,
  credential?: string,
): Promise<Delegation | undefined> {
  if (!UUID.test(key)) return undefined;
  const rows = await tx.query<HeldDelegationRow>(
    state === 'live'
      ? `select d.id, d.agent_actor_id, d.delegate_person_id, d.minted_by_actor_id, d.purpose,
                d.collections, d.actions, d.purpose_scope_id, d.expires_at
           from public.delegations d
          where d.business_id = $1 and d.agent_actor_id = $2 and d.id = $3
            and d.revoked_at is null and d.settled_at is null and d.expires_at > now()`
      : `select d.id, d.agent_actor_id, d.delegate_person_id, d.minted_by_actor_id, d.purpose,
                d.collections, d.actions, d.purpose_scope_id, d.expires_at
           from public.delegations d
           join public.leases l on l.business_id = d.business_id and l.delegation_id = d.id
          where d.business_id = $1 and d.agent_actor_id = $2 and l.id = $3
            and d.credential_hash = $4
            and d.revoked_at is null and d.settled_at is not null and d.expires_at > now()`,
    state === 'live'
      ? [tx.businessId, session.actorId, key]
      : [tx.businessId, session.actorId, key, digestOf(credential ?? '')],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    id: row.id,
    agentActorId: row.agent_actor_id,
    delegatePersonId: row.delegate_person_id,
    mintedByActorId: row.minted_by_actor_id,
    purpose: row.purpose,
    collections: row.collections,
    actions: row.actions,
    purposeScope: { kind: 'record', id: row.purpose_scope_id },
    expiresAt: row.expires_at,
  };
}
