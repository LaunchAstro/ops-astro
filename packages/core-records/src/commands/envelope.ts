// SPDX-License-Identifier: AGPL-3.0-only
//
// The command envelope. Every command goes through it and none of them can
// choose not to.
//
// It owns five things, and each one is here rather than in a command because a
// rule held in one command is a rule the next command forgets:
//
// 1. **The repeat-request identity.** Required, shaped, and looked up before
//    any work. The same identity with the same payload replays the original
//    result; with a different payload it is refused `OPERATION_ID_REUSED`.
// 2. **`expected_revision`.** Required on every command with an existing
//    record to be stale against, compared against the server's own revision.
// 3. **Authority.** Checked inside the serving transaction through T1c's
//    grants, so a revocation bites on the next call rather than soon.
// 4. **The audit event.** Written on every attempt: applied, refused,
//    replayed, and the ones that raised.
// 5. **Atomicity of a refusal.** The handler's writes sit inside a savepoint
//    that is rolled back the moment it refuses, so a command cannot half-apply
//    and then say no. That is a mechanism rather than a convention: a handler
//    that writes before it checks still cannot leave the write behind.
//
// The one thing it does not own is authority *semantics*. Which action a
// command needs is on its declaration and the decision is T1c's; the envelope
// asks and reports. No authority check lives only here, and none lives only in
// the transport above it.

import type { BusinessId, Database, TenantQuery } from '../tenancy/database.ts';
import type { Session, VerifiedSubject } from '../identity/login-resolution.ts';
import { withSession } from '../identity/login-resolution.ts';
import { payloadDigest } from './digest.ts';
import { writeAuditEvent } from './audit.ts';
import {
  asCallerVisible,
  fromIdentity,
  isCommandRefusal,
  isIdentityRefusal,
  refuseCommand,
  type CommandRefusal,
} from './refusal.ts';
import { declarationOf, type CommandDeclaration } from './surface.ts';
import {
  OPERATION_ID,
  isRetryableViolation,
  lookupAttempt,
  registerAttempt,
  type CommandHandle,
  type CommandResult,
  type RegisteredAttempt,
} from './register-store.ts';
import { comparablePayload, type CommandRequest } from './requests.ts';
import type { EntryPoint } from '../tasks/placement.ts';
import { handleCommand } from './handlers.ts';
import { isRefused, type Applied, type Refused } from './outcome.ts';
import { REVISION_FIXES, expectedRevisionOf, prepareCommand } from './prepare.ts';

const IDENTITY_FIXES: readonly string[] = [
  'Send an operation_id: 8 to 200 characters of letters, digits, dot, colon, dash or underscore.',
  'Present the same one to retry the same request, and a new one for a new attempt.',
];

/**
 * Run one command inside an open transaction whose business is set and whose
 * session is resolved.
 *
 * The transaction is the caller's, which is what lets the worker and the HTTP
 * boundary reach the same operation without either of them owning it.
 */
export async function runCommand(
  tx: TenantQuery,
  session: Session,
  entryPoint: EntryPoint,
  request: CommandRequest,
): Promise<CommandResult> {
  const declaration = declarationOf(request.command);
  if (declaration === undefined) {
    throw new Error(`runCommand: ${request.command} is not in the command surface`);
  }
  const digest = payloadDigest(comparablePayload(request));

  // The identity first, because an attempt with no identity is not an attempt
  // the register can hold, and it is still an attempt the chain records.
  // `typeof` first, and it is not belt and braces. `RegExp.prototype.test`
  // coerces its argument to a string, so an omitted `operationId` -- the field
  // an ordinary HTTP caller leaves out most easily -- arrives as `undefined`,
  // coerces to the nine-character `"undefined"`, and passes the pattern. The
  // real `undefined` then reaches `lookupAttempt`'s bound parameter and the
  // driver raises `UNDEFINED_VALUE`, which the boundary shows as a plain 500.
  // `null` and `''` were always refused correctly; the absent field was not.
  if (typeof request.operationId !== 'string' || !OPERATION_ID.test(request.operationId)) {
    return await settle(tx, session, request, digest, {
      refusal: refuseCommand('OPERATION_ID_REQUIRED', [], IDENTITY_FIXES),
      withoutIdentity: true,
    });
  }

  const seen = await lookupAttempt(tx, session.actorId, request.operationId);
  if (seen !== undefined) return await replayOrRefuse(tx, session, request, digest, seen);

  if (declaration.targetsExistingRecord && typeof expectedRevisionOf(request) !== 'number') {
    return await settle(tx, session, request, digest, {
      refusal: refuseCommand('EXPECTED_REVISION_REQUIRED', [], REVISION_FIXES),
    });
  }

  return await attempt(tx, session, entryPoint, request, digest, declaration);
}

/**
 * The whole of a call: open the transaction, resolve the session, run the
 * command — and deal with the two things that can only be dealt with out here.
 *
 * **Why recovery is at the transaction boundary and not at a savepoint.** This
 * driver rejects the whole `begin` promise on the first statement error even
 * when the error is caught and the savepoint is rolled back: the statement can
 * be recovered from, and then the wrapper rolls the transaction back anyway.
 * Proved against this server. So a raised statement cannot be retried inside
 * the transaction that raised it, and an audit event for it cannot be written
 * there either — it would roll back with the failure it was recording.
 *
 * That gives two rules, both here:
 *
 * 1. **A unique violation is retried once, in a fresh transaction.** Two
 *    shapes of race resolve through the same rule. Two callers presenting one
 *    operation identity at once: the loser's whole attempt is gone, the
 *    winner's register row is committed, and the retry reads it and replays.
 *    Two creates at once: both counted the same `key`, the loser was refused
 *    by `record_unique_values`, and the retry counts again and takes the next
 *    number — which is the retry T1e's handback asked this part for.
 * 2. **An attempt that raised still writes its audit event**, in a transaction
 *    of its own, because "every attempt writes an audit event" has to include
 *    the attempts that broke. It carries no message: a message may carry a
 *    value.
 *
 * A second collision propagates. Two failures on a re-read counter is a
 * different problem — a high-water mark is the fix, and it is a table this
 * slice does not have — and a retry loop would hide it.
 */
export async function executeCommand(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  entryPoint: EntryPoint,
  request: CommandRequest,
): Promise<CommandResult> {
  return await retryOnce(
    async () => await callOnce(database, businessId, presented, entryPoint, request),
    // Only when the fault is actually being handed to the caller. A review
    // found the earlier order leaving a `failed` event beside the `applied`
    // one every time a retry won, which reads as two attempts.
    async (cause) => await recordFailure(database, businessId, presented, request, cause),
  );
}

/**
 * `run`, and once more in a fresh attempt when the first lost a race
 * `isRetryableViolation` names. Both entries take it: the person entry
 * (`executeCommand`) and the agent entry (`agent-envelope.ts`).
 *
 * One retry, never more. Any other failure, or a second retryable one, goes to
 * `onFinalFailure` when there is one and then propagates.
 */
export async function retryOnce<T>(
  run: () => Promise<T>,
  onFinalFailure?: (cause: unknown) => Promise<void>,
): Promise<T> {
  for (let attempts = 0; ; attempts += 1) {
    try {
      // A retry is sequential by definition: the second attempt exists only
      // because the first one lost, and it has to read what the winner wrote.
      // oxlint-disable-next-line no-await-in-loop
      return await run();
    } catch (cause) {
      if (attempts === 0 && isRetryableViolation(cause)) continue;
      // oxlint-disable-next-line no-await-in-loop
      if (onFinalFailure !== undefined) await onFinalFailure(cause);
      throw cause;
    }
  }
}

async function callOnce(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  entryPoint: EntryPoint,
  request: CommandRequest,
): Promise<CommandResult> {
  const outcome = await withSession(
    database,
    businessId,
    presented,
    async (tx, session) => await runCommand(tx, session, entryPoint, request),
  );
  // An unresolved login has no actor to attribute an audit event to, and
  // `audit_events.actor_id` is not null. The refusal is returned as it is; the
  // gap is recorded in the handback rather than papered over with a fabricated
  // actor.
  if (isIdentityRefusal(outcome)) return asCallerVisible(fromIdentity(outcome));
  return outcome;
}

/**
 * One event for an attempt that raised, in its own transaction.
 *
 * If this write itself fails there is nothing useful to do about it here, and
 * the original fault is the one the caller has to see, so the second failure
 * is attached as the cause of a warning rather than replacing it. A caller
 * never sees this function; the chain does.
 */
async function recordFailure(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  request: CommandRequest,
  original: unknown,
): Promise<void> {
  try {
    await withSession(database, businessId, presented, async (tx, session) => {
      await writeAuditEvent(tx, {
        actorId: session.actorId,
        command: request.command,
        operationId: OPERATION_ID.test(request.operationId) ? request.operationId : null,
        outcome: 'failed',
        payloadDigest: payloadDigest(comparablePayload(request)),
      });
      return undefined;
    });
  } catch (secondary) {
    console.warn('executeCommand: the failed attempt could not be recorded', {
      command: request.command,
      cause: secondary instanceof Error ? secondary.message : 'unknown',
      original: original instanceof Error ? original.message : 'unknown',
    });
  }
}

async function replayOrRefuse(
  tx: TenantQuery,
  session: Session,
  request: CommandRequest,
  digest: string,
  seen: RegisteredAttempt,
): Promise<CommandResult> {
  // The command name is part of the compared payload, so one identity used
  // for two different commands differs here without a second comparison. A
  // separate check on `seen.command` was written first and then removed: a
  // mutation showed it could not fail, which means it was a claim about the
  // digest rather than a check on the request.
  if (seen.payload_digest !== digest) {
    return await settle(tx, session, request, digest, {
      refusal: refuseCommand(
        'OPERATION_ID_REUSED',
        [seen.command],
        [
          'This identity already carries a different request. Use a new operation_id.',
          'The first result stands; returning it for a second payload would hide your bug.',
        ],
      ),
      // The register already holds this identity, so nothing is written to it.
      registered: true,
    });
  }

  // The original result, returned exactly. A caller cannot tell a replay from
  // the first call, which is the point; the chain can, which is also the point.
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

async function attempt(
  tx: TenantQuery,
  session: Session,
  entryPoint: EntryPoint,
  request: CommandRequest,
  digest: string,
  declaration: CommandDeclaration,
): Promise<CommandResult> {
  await tx.query('savepoint command_attempt');
  try {
    const outcome = await attemptWork(tx, session, entryPoint, request, declaration);
    if (isRefused(outcome)) {
      // The register stores what the caller was **shown**, not the refusal the
      // operation produced. A replay returns the stored result verbatim, so
      // storing the untranslated one would hand a second caller an audit-only
      // code the first caller never saw — the one mechanism the visibility
      // column exists for, defeated on the replay path. A review found this.
      await record(tx, session, request, digest, asCallerVisible(outcome.refusal), null);
      return await settle(tx, session, request, digest, { ...outcome, registered: true });
    }
    const handle: CommandHandle = {
      command: request.command,
      recordId: outcome.recordId,
      revision: outcome.revision,
      detail: outcome.detail,
    };
    await record(tx, session, request, digest, handle, outcome.recordId);
    await tx.query('release savepoint command_attempt');
    await writeAuditEvent(tx, {
      actorId: session.actorId,
      command: request.command,
      operationId: request.operationId,
      outcome: 'applied',
      subjectRecordId: outcome.recordId,
      payloadDigest: digest,
    });
    return handle;
  } catch (cause) {
    // The savepoint is rolled back so the statement log reads honestly, and
    // then the fault leaves: this driver has already condemned the
    // transaction, so the audit event and any retry belong to
    // `executeCommand`, which has a transaction of its own to write them in.
    await tx.query('rollback to savepoint command_attempt').catch(() => undefined);
    throw cause;
  }
}

/**
 * The handler's writes, inside a savepoint of their own.
 *
 * A refusal cannot leave a partial write behind: the savepoint is rolled back
 * the moment the handler says no, before anything records the refusal, so a
 * handler that writes before it checks still cannot half-apply.
 *
 * **Stated plainly: no handler in this part reaches that.** Every one of them
 * refuses before it writes, so today the savepoint is insurance against a
 * handler nobody has written yet rather than a mechanism holding something
 * up. It is here because "refuse before you write" is a discipline and a
 * discipline is what the next command forgets — but it should be read as what
 * it is, and the discipline is what is actually holding.
 */
async function attemptWork(
  tx: TenantQuery,
  session: Session,
  entryPoint: EntryPoint,
  request: CommandRequest,
  declaration: CommandDeclaration,
): Promise<Applied | Refused> {
  await tx.query('savepoint command_work');
  const outcome = await work(tx, session, entryPoint, request, declaration);
  await tx.query(
    // A refusal rolls back, except the one that kept something on purpose:
    // `Refused.retains` is set by a handler that wrote a row the contract
    // retains alongside the refusal, and rolling back would discard it.
    isRefused(outcome) && outcome.retains !== true
      ? 'rollback to savepoint command_work'
      : 'release savepoint command_work',
  );
  return outcome;
}

/** The preparation and then the command, which is all that is inside the savepoint. */
async function work(
  tx: TenantQuery,
  session: Session,
  entryPoint: EntryPoint,
  request: CommandRequest,
  declaration: CommandDeclaration,
): Promise<Applied | Refused> {
  const prepared = await prepareCommand(tx, session, entryPoint, request, declaration);
  if ('refusal' in prepared) return prepared;
  return await handleCommand(tx, prepared, request);
}

/** One register row for this request, whatever it came to. */
async function record(
  tx: TenantQuery,
  session: Session,
  request: CommandRequest,
  digest: string,
  result: CommandHandle | CommandRefusal,
  recordId: string | null,
): Promise<void> {
  await registerAttempt(tx, {
    operationId: request.operationId,
    command: request.command,
    actorId: session.actorId,
    digest,
    result,
    recordId,
  });
}

interface Settlement extends Refused {
  /** The register already holds this identity, or there is no identity to hold. */
  readonly registered?: boolean;
  readonly withoutIdentity?: boolean;
}

/** Record the refusal, then hand the caller the version they are allowed to see. */
async function settle(
  tx: TenantQuery,
  session: Session,
  request: CommandRequest,
  digest: string,
  settlement: Settlement,
): Promise<CommandRefusal> {
  const { refusal, attempted } = settlement;
  if (settlement.registered !== true && settlement.withoutIdentity !== true) {
    await record(tx, session, request, digest, asCallerVisible(refusal), null);
  }
  await writeAuditEvent(tx, {
    actorId: session.actorId,
    command: request.command,
    operationId: settlement.withoutIdentity === true ? null : request.operationId,
    outcome: 'refused',
    refusalCode: refusal.code,
    subjectRecordId: null,
    payloadDigest: digest,
    attempted: attempted ?? null,
  });
  return asCallerVisible(refusal);
}
