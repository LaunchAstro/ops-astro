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
// prefix and its answer is the agent's own, not the delegating person's: its
// own acting identity, the business key, the purpose its delegation is bounded
// to (null before a pickup) and the authority the two pre-pickup operations
// take. An agent holds no grants of its own -- see below -- so reporting the
// delegating person's here would be reporting somebody else's authority as the
// agent's.
//
// **The two operations before there is anything to delegate.** An agent that
// has not picked work up holds no delegation, so there is nothing to intersect
// its call with. It may do exactly two things: read `task.queue` and call
// `task.pickup`. Every other operation is refused `DELEGATION_NOT_LIVE`, which
// is the code AUTHORITY.md names for a credential that does not answer to a
// live delegation — and "none was presented" is that, told apart from
// "expired", "revoked" and "settled" by nothing, deliberately, because telling
// them apart tells a caller holding a stolen credential which of those it is.
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
  resolveDelegation,
  type Delegation,
} from '../authority/delegations.ts';
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
import { isRefused, type HandlerOutcome } from './outcome.ts';

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
 * `session.capabilities` is not a third. It is reachable before a pickup for
 * the same reason it takes no grant on the person path -- it reports what the
 * caller already holds and confers nothing -- and it is kept out of this set
 * because this set is the *ceiling* the refusal message quotes, and an agent
 * reading its own capabilities should be told the two operations it may do,
 * not three.
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
    await writeAuditEvent(tx, {
      actorId: session.actorId,
      command: request.command,
      operationId: request.operationId,
      outcome: 'replayed',
      refusalCode: isCommandRefusal(replayed) ? replayed.code : null,
      subjectRecordId: isCommandRefusal(replayed) ? null : replayed.recordId,
      payloadDigest: digest,
    });
    return replayed;
  }

  const authorised = await authorise(tx, session, credential, request);
  if (authorised !== undefined) return await settle(tx, session, request, digest, authorised);

  await tx.query('savepoint agent_work');
  const outcome = await serve(tx, session, credential, request);
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
  if (isRefused(outcome)) return await settle(tx, session, request, digest, outcome.refusal);

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
    result: handle,
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

  // The agent asking what it may do is answered whether or not it holds a
  // delegation: with one the answer is that delegation's purpose, without one
  // it is the pre-pickup pair and a null purpose. Refusing it for want of a
  // credential would refuse the one call whose whole subject is that the
  // credential is missing.
  if (request.command === 'session.capabilities') return undefined;

  if (credential === undefined || credential === '') {
    return refuseCommand('DELEGATION_NOT_LIVE', [], NO_DELEGATION_FIXES);
  }
  const resolved = await resolveDelegation(tx, session.actorId, credential);
  if (!resolved.ok) return fromRuntime(resolved.refusal);
  const delegation = resolved.value;

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
          ...(typeof request['leaseSeconds'] === 'number'
            ? { leaseSeconds: request['leaseSeconds'] }
            : {}),
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
          ...(typeof request['report'] === 'object' && request['report'] !== null
            ? { report: request['report'] as Readonly<Record<string, unknown>> }
            : {}),
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
          ...('leaseSeconds' in request ? { leaseSeconds: request['leaseSeconds'] } : {}),
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
  });
  return visible;
}

/** Everything the register compares, which is the request without its identity. */
function comparable(request: AgentRequest): Readonly<Record<string, unknown>> {
  const { operationId: _identity, ...rest } = request;
  return rest;
}
