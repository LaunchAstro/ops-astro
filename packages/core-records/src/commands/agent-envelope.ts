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
import { resolveAgentLogin } from '../identity/agent-login.ts';
import { payloadDigest } from './digest.ts';
import { asCallerVisible, fromAgentIdentity, isCommandRefusal, refuseCommand } from './refusal.ts';
import {
  COMMAND_SURFACE,
  declarationOf,
  type CommandDeclaration,
  type CommandName,
} from './surface.ts';
import {
  OPERATION_ID,
  lookupAttempt,
  registerAttempt,
  type CommandHandle,
  type CommandResult,
} from './register-store.ts';
import { retryOnce } from './envelope.ts';
import { isRefused } from './outcome.ts';
import { authorise } from './agent-authority.ts';
import { answerReplay } from './agent-replay.ts';
import { settle, writeCallEvent } from './agent-settle.ts';
import { AGENT_OPERATIONS, parseOperands } from './agent-operations.ts';
import type { AgentCall, AgentRequest } from './agent-call.ts';

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
  // before any executor is reached (`apps/api/app.ts`, THERMO-RECHECK NC2).
  presented: VerifiedSubject,
  credential: string | undefined,
  request: AgentRequest,
): Promise<CommandResult> {
  // One bounded retry, `retryOnce` in `envelope.ts`, which the person entry
  // takes too, on its shared predicate (`isRetryableViolation`). It admits a lost
  // identity claim: a same-operationId retry in flight behind its original
  // read no register row, then lost `operations_identity_key` to the
  // original's commit; its whole transaction is gone, so the second attempt
  // reads the committed row and replays it rather than answering a fault
  // (DB-PROOF-GAPS-B F1). The predicate is not identity-only: it also admits
  // `AffectedSetChanged` and a lost unique-value claim, under the same single
  // retry. A second retryable failure of any kind propagates. There is no
  // `onFinalFailure` here: an agent attempt that raised is answered by the
  // fault alone.
  return await retryOnce(
    async () =>
      await database.withBusiness(businessId, async (tx) => {
        const session = await resolveAgentLogin(tx, presented);
        // No actor, so no audit event can be attributed. `resolveAgentLogin`
        // has already written the authentication attempt, which is the record
        // that exists for exactly this case (AUTHORITY.md, "every attempt at
        // the door").
        if ('refused' in session) return asCallerVisible(fromAgentIdentity(session));
        return await runAgentCommand(tx, { session, credential, request });
      }),
  );
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
  presented: Omit<AgentCall, 'declaration'>,
): Promise<CommandResult> {
  const { session, request } = presented;
  const digest = payloadDigest(comparable(request));
  const operation = AGENT_OPERATIONS.get(request.command);
  const declaration = declarationOf(request.command);
  if (declaration === undefined || operation === undefined) {
    return await settle(
      tx,
      session,
      request,
      digest,
      refuseCommand(
        'DELEGATION_EXCLUDES_OPERATION',
        [request.command],
        [
          'An agent reaches the queue and a pickup, then, under the delegation the pickup gave it, its own task: read, comment, heartbeat, handback and its capabilities.',
          'Every other operation belongs to a person.',
        ],
      ),
      true,
    );
  }
  const call: AgentCall = { ...presented, declaration };

  // `typeof` first, as the person envelope asks it (`envelope.ts`). The pattern
  // coerces what it is given, so a number or a one-element array would pass as
  // the string it prints as, and register or collide with a later request that
  // sent that string; an absent identity would pass as `"undefined"` and reach
  // the register's bound parameter as a fault. The type is the envelope's to
  // hold, whatever the boundary in front of it passes through (Sol 6
  // AUTHORITY-4).
  if (typeof request.operationId !== 'string' || !OPERATION_ID.test(request.operationId)) {
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
  if (seen !== undefined) return await answerReplay(tx, call, operation, seen, digest);

  // The request's own shape, before any authority is read: a system-owned
  // field (D06, the person path's own classifier) and then each operand the
  // command takes. Neither tells the caller anything about the business.
  const operands = await parseOperands(tx, request, operation);
  if ('refusal' in operands) {
    return await settle(tx, session, request, digest, operands.refusal, false, operands.attempted);
  }

  const authorised = await authorise(tx, call, operation);
  if ('refusal' in authorised) {
    await operation.onRefused?.(tx, call, operands, authorised.refusal);
    return await settle(tx, session, request, digest, authorised.refusal);
  }

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
  await writeCallEvent(tx, session, request, digest, {
    outcome: 'applied',
    subjectRecordId: outcome.recordId,
  });
  return handle;
}

/** Everything the register compares, which is the request without its identity. */
function comparable(request: AgentRequest): Readonly<Record<string, unknown>> {
  const { operationId: _identity, ...rest } = request;
  return rest;
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
