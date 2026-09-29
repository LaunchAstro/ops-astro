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
// its delegation is bounded to and the pairs that purpose carries which the
// delegating person's effective grants still cover on it, read on every call
// and on every replay (root ruling 5). An agent holds no grants of its own --
// see below -- so reporting the delegating person's here would be reporting
// somebody else's authority as the agent's.
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
// `DELEGATION_EXCLUDES_DECISION` by the runtime's `decideAsAgent`, which asks
// the delegation check and returns its answer rather than inventing a runtime
// code for it.
//
// **What this path does not duplicate.** The repeat-request identity, the
// register lookup, the replay and the settling of a refusal are the person
// envelope's own, reached through `enter` and `settle` in `envelope.ts`, and
// the body is parsed against the same surface row (`parseRequest`). This
// entry is a policy over them: its reach, how a stored answer is released and
// how a fresh call is authorised and run. What it cannot reuse is
// `runCommand`'s preparation: that takes a `Session`, which has a `personId`,
// and an `AgentSession` has no `personId` field at all. Not null — absent.
// Synthesising one so the person envelope would accept an agent is exactly the
// collapse the identity model exists to prevent, and it would put the
// delegating person's identity on the agent's audit rows.

import { resolveAgentLogin } from '../../../core-records/src/index.ts';
import type {
  BusinessId,
  Database,
  TenantQuery,
  VerifiedSubject,
} from '../../../core-records/src/index.ts';
import { COMMAND_SURFACE, declarationOf } from '../../../core-wire/src/index.ts';
import type { CommandDeclaration, CommandName } from '../../../core-wire/src/index.ts';
import { asCallerVisible, isCommandRefusal, refuseCommand } from './refusal.ts';
import { crashPointAfterCommit } from '../../../core-runtime/src/index.ts';
import { registerAttempt, type CommandHandle, type CommandResult } from './register-store.ts';
import { enter, retryOnce, settle } from './envelope.ts';
import { isRefused } from './outcome.ts';
import { authorise } from './agent-authority.ts';
import { releaseReplay } from './agent-replay.ts';
import { writeAuditEvent } from './audit.ts';
import {
  AGENT_OPERATIONS,
  isOperandRefusal,
  parseOperands,
  type TypedOperation,
} from './agent-operations.ts';
import { parseRequest, refuseUndescribed } from './operands.ts';
import type { AgentCall, AgentRequest } from './agent-call.ts';
import type { IdentifiedRequest } from './requests.ts';

/**
 * The two operations an agent may reach before it holds anything.
 *
 * `session.capabilities` is not a third: before a pickup it is refused
 * `DELEGATION_EXCLUDES_OPERATION` like every other operation outside this set
 * (minimum contract 8.2 case 9). Under a live delegation it answers the
 * delegation's purpose.
 */
export const BEFORE_PICKUP: ReadonlySet<CommandName> = agentReach(['before-pickup']);

/**
 * What an agent may reach at all, delegation or not. Both sets are read off the
 * surface rows' own `agent` field, so the surface table is the one place that
 * says what an agent reaches; `AGENT_OPERATIONS` says how each is served, and
 * `tests/commands/agent-surface-derivation.test.ts` holds the two to one list.
 */
export const AGENT_SURFACE: ReadonlySet<CommandName> = agentReach(['before-pickup', 'delegated']);

function agentReach(reach: readonly CommandDeclaration['agent'][]): ReadonlySet<CommandName> {
  return new Set(COMMAND_SURFACE.filter((row) => reach.includes(row.agent)).map((row) => row.name));
}

export async function executeAgentCommand(
  database: Database,
  businessId: BusinessId,
  // Verified, never `'expired'`: the one door answers an expired bearer
  // before any executor is reached (`apps/api/app.ts`).
  presented: VerifiedSubject,
  credential: string | undefined,
  request: AgentRequest,
): Promise<CommandResult> {
  // One bounded retry, `retryOnce` in `envelope.ts`, which the person entry
  // takes too, on its shared predicate (`isRetryableViolation`). It admits a lost
  // identity claim: a same-operationId retry in flight behind its original
  // read no register row, then lost `operations_identity_key` to the
  // original's commit; its whole transaction is gone, so the second attempt
  // reads the committed row and replays it rather than answering a fault.
  // The predicate is not identity-only: it also admits
  // `AffectedSetChanged` and a lost unique-value claim, under the same single
  // retry. A second retryable failure of any kind propagates. There is no
  // `onFinalFailure` here: an agent attempt that raised is answered by the
  // fault alone.
  const result = await retryOnce(
    async () =>
      await database.withBusiness(businessId, async (tx) => {
        const session = await resolveAgentLogin(tx, presented);
        // No actor, so no audit event can be attributed. `resolveAgentLogin`
        // has already written the authentication attempt, which is the record
        // that exists for exactly this case (AUTHORITY.md, "every attempt at
        // the door").
        if ('refused' in session) return asCallerVisible(session);
        return await runAgentCommand(tx, { session, credential, request });
      }),
  );
  // Committed: the lost-response gap before the worker reads this (T2c1).
  await crashPointAfterCommit(
    request.command,
    isCommandRefusal(result) ? undefined : result.detail,
    process.env,
  );
  return result;
}

/**
 * What the agent prefix puts on the wire for a result, which is the handle
 * except for the one read the person prefix also serves.
 *
 * `session.capabilities` answers flattened beside `ok` on the person prefix,
 * which is the shape the mounted app reads (`reads/capabilities.ts`,
 * `SessionCapabilities`). Here the envelope nests every payload under
 * `detail`. Left nested, the same read would arrive in two shapes and a
 * client would have to know which prefix it was on. This flattens it here,
 * at the wire, rather than in `serve`: the register row keeps the handle
 * every other agent answer is stored as, so a replay reads the same record and
 * is shaped the same way on the way out. A refusal never reaches here: the
 * boundary answers it first (`apps/api/app.ts`).
 */
export function agentAnswer(
  command: CommandName,
  result: CommandHandle,
): CommandHandle | Readonly<Record<string, unknown>> {
  return command === 'session.capabilities' ? { ok: true, ...result.detail } : result;
}

const OUTSIDE_FIXES: readonly string[] = [
  'An agent reaches the queue and a pickup, then, under the delegation the pickup gave it, its own task: read, comment, propose, heartbeat, dispatch, observe, handback and its capabilities.',
  'Every other operation belongs to a person.',
];

async function runAgentCommand(
  tx: TenantQuery,
  presented: {
    readonly session: AgentCall['session'];
    readonly credential: string | undefined;
    readonly request: AgentRequest;
  },
): Promise<CommandResult> {
  const { session, credential, request } = presented;
  const operation = AGENT_OPERATIONS.get(request.command);
  if (operation === undefined) {
    const outside = refuseCommand(
      'DELEGATION_EXCLUDES_OPERATION',
      [request.command],
      OUTSIDE_FIXES,
    );
    return await enter(tx, session, request, { outside });
  }
  const declaration = declarationOf(request.command);
  const callOf = (identified: IdentifiedRequest): AgentCall => ({
    session,
    credential,
    request: identified,
    declaration,
  });
  return await enter(tx, session, request, {
    release: async (stored, identified) =>
      await releaseReplay(tx, callOf(identified), operation, stored),
    attempt: async (identified, digest) =>
      await operation.open(
        async (row) => await runRow(tx, callOf(identified), identified, row, digest),
      ),
  });
}

/** The rest of a call, generic over the row's operands (`AgentOperation`). */
async function runRow<O extends object>(
  tx: TenantQuery,
  call: AgentCall,
  request: IdentifiedRequest,
  operation: TypedOperation<O>,
  digest: string,
): Promise<CommandResult> {
  const { session } = call;
  // The request's own shape, before any authority is read: a system-owned
  // field (D06, the person path's own classifier) and then each operand the
  // command takes. Neither tells the caller anything about the business.
  const operands = await parseOperands(tx, request, operation);
  if (isOperandRefusal(operands)) {
    const { refusal, attempted } = operands;
    return await settle(tx, session, request, digest, refusal, 'register', attempted);
  }

  const authorised = await authorise(tx, call, operation);
  if ('refusal' in authorised) {
    await operation.onRefused?.(tx, call, operands, authorised.refusal);
    return await settle(tx, session, request, digest, authorised.refusal);
  }
  // The body against its surface row, as the person prefix parses it and at
  // the same point: after authority, before the savepoint and any command
  // code. The row's own parser above has already read what it types.
  // A field the row does not describe, after `authorise` as on the person
  // prefix: the delegation's answers come first
  // (`tests/commands/agent-operation-order.test.ts` pins that order).
  const undescribed = refuseUndescribed(request, call.declaration);
  if (undescribed !== undefined) return await settle(tx, session, request, digest, undescribed);
  const parsed = parseRequest(request, call.declaration);
  if ('refusal' in parsed) return await settle(tx, session, request, digest, parsed.refusal);

  await tx.query('savepoint agent_work');
  const outcome = await authorised.run(operands);
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
    const { refusal, attempted } = outcome;
    return await settle(tx, session, request, digest, refusal, 'register', attempted);
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
    payloadDigest: digest,
    outcome: 'applied',
    subjectRecordId: outcome.recordId,
  });
  return handle;
}

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
