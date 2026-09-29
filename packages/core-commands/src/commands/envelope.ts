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

import { withSession } from '../../../core-records/src/index.ts';
import type {
  BusinessId,
  Database,
  TenantQuery,
  Session,
  VerifiedSubject,
  EntryPoint,
} from '../../../core-records/src/index.ts';
import { declarationOf } from '../../../core-wire/src/index.ts';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import type { CommandDeclaration } from '../../../core-wire/src/index.ts';
import { storable, writeAuditEvent } from './audit.ts';
import {
  asCallerVisible,
  isCommandRefusal,
  refuseCommand,
  type CommandRefusal,
} from './refusal.ts';
import {
  isRetryableViolation,
  lookupAttempt,
  registerAttempt,
  type CommandHandle,
  type CommandResult,
  type RegisteredAttempt,
} from './register-store.ts';
import {
  comparablePayload,
  hasIdentity,
  type CommandRequest,
  type IdentifiedRequest,
  type UncheckedRequest,
} from './requests.ts';
import { handleCommand } from './handlers.ts';
import { isRefused, refused, type Applied, type Refused } from './outcome.ts';
import { pickupReceiptBinding } from './pickup-receipt.ts';
import { REVISION_FIXES, expectedRevisionOf, prepareCommand } from './prepare.ts';

const IDENTITY_FIXES: readonly string[] = [
  'Send an operation_id: 8 to 200 characters of letters, digits, dot, colon, dash or underscore.',
  'Present the same one to retry the same request, and a new one for a new attempt.',
];

/** Whoever the call is attributed to: a person's actor or an agent's. */
export interface Caller {
  readonly actorId: string;
}

/**
 * What one entry does differently, the rest of a call being the same on both
 * prefixes: the identity check, the register lookup, the replay and the
 * settling are `enter`'s, once. An entry either refuses the call before its
 * identity is read (the agent's reach), or releases a stored answer and runs a
 * fresh attempt its own way.
 */
export type Entry =
  | { readonly outside: CommandRefusal }
  | {
      /**
       * A stored success as the rights held now release it: an answer in its
       * place, a refusal, or nothing when it goes out as stored.
       */
      readonly release: (
        stored: CommandHandle,
        request: IdentifiedRequest,
      ) => Promise<CommandResult | Refused | undefined>;
      /** A request the register has not seen, carrying a usable identity. */
      readonly attempt: (request: IdentifiedRequest, digest: string) => Promise<CommandResult>;
    };

/**
 * The part of every call that is the same on both prefixes, in this order:
 * the entry's own exclusion, the repeat-request identity, the register lookup
 * and the replay, then the entry's attempt.
 */
export async function enter(
  tx: TenantQuery,
  caller: Caller,
  request: UncheckedRequest,
  entry: Entry,
): Promise<CommandResult> {
  const digest = payloadDigest(comparablePayload(request));
  if ('outside' in entry) return await settle(tx, caller, request, digest, entry.outside, 'none');
  // The identity first, because an attempt with no identity is not an attempt
  // the register can hold, and it is still an attempt the chain records.
  // `hasIdentity` asks `typeof` first, and it is not belt and braces.
  // `RegExp.prototype.test` coerces its argument to a string, so an omitted
  // `operationId` -- the field an ordinary HTTP caller leaves out most easily
  // -- would coerce to the nine-character `"undefined"` and pass the pattern,
  // and a number or a one-element array would pass as the string it prints as.
  if (!hasIdentity(request)) {
    const refusal = refuseCommand('OPERATION_ID_REQUIRED', [], IDENTITY_FIXES);
    return await settle(tx, caller, request, digest, refusal, 'none');
  }
  // One register for both prefixes, keyed on the caller's own actor, so a
  // pickup retried after a lost response replays the lease it already holds.
  const seen = await lookupAttempt(tx, caller.actorId, request.operationId);
  if (seen !== undefined) {
    const release = async (stored: CommandHandle) => await entry.release(stored, request);
    return await replay(tx, caller, request, digest, seen, release);
  }
  return await entry.attempt(request, digest);
}

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
  request: UncheckedRequest,
): Promise<CommandResult> {
  const declaration = declarationOf(request.command);
  return await enter(tx, session, request, {
    release: async (stored) =>
      await withheldNow(tx, session, entryPoint, request, declaration, stored),
    attempt: async (identified, digest) => {
      if (declaration.targetsExistingRecord && typeof expectedRevisionOf(identified) !== 'number') {
        const refusal = refuseCommand('EXPECTED_REVISION_REQUIRED', [], REVISION_FIXES);
        return await settle(tx, session, identified, digest, refusal);
      }
      return await attempt(tx, session, entryPoint, identified, digest, declaration);
    },
  });
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
  // Typed callers and unchecked bodies alike: either is parsed against its row.
  request: CommandRequest | UncheckedRequest,
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
  request: UncheckedRequest,
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
  if (isCommandRefusal(outcome)) return asCallerVisible(outcome);
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
  request: UncheckedRequest,
  original: unknown,
): Promise<void> {
  try {
    await withSession(database, businessId, presented, async (tx, session) => {
      await writeAuditEvent(tx, {
        actorId: session.actorId,
        command: request.command,
        operationId: hasIdentity(request) ? request.operationId : null,
        outcome: 'failed',
        payloadDigest: failedDigest(request),
      });
      return undefined;
    });
  } catch (secondary) {
    console.warn(
      `executeCommand: the failed attempt at ${request.command} could not be recorded ` +
        `(${describeFault(secondary)}); the attempt itself failed with ${describeFault(original)}`,
    );
  }
}

/**
 * What a log may say about a fault: the driver's code and constraint, or the
 * error's class. Never the message, which can quote what a caller sent.
 */
export function describeFault(cause: unknown): string {
  const fault: Readonly<Record<string, unknown>> =
    typeof cause === 'object' && cause !== null ? (cause as Record<string, unknown>) : {};
  const code =
    bounded(fault['code'], FAULT_CODE) ?? bounded(fault['name'], IDENTIFIER) ?? 'unknown';
  const constraint = bounded(fault['constraint_name'], IDENTIFIER);
  return constraint === undefined ? code : `${code} on ${constraint}`;
}

function bounded(value: unknown, shape: RegExp): string | undefined {
  return typeof value === 'string' && shape.test(value) ? value : undefined;
}

// A SQLSTATE (`22P02`) or a runtime's code (`ECONNREFUSED`); an identifier or class name.
const FAULT_CODE = /^[0-9A-Z_]{1,40}$/u;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;

/**
 * The digest a `failed` event carries.
 *
 * A payload with no canonical form (a non-finite number from a direct caller;
 * the HTTP door refuses one before this) is often why the attempt failed, and
 * taking its digest again would throw inside the fallback and lose the event
 * with it. It gets the all-zero digest instead, which the
 * column's shape admits and no SHA-256 of a payload will realistically be.
 */
function failedDigest(request: UncheckedRequest): string {
  try {
    return payloadDigest(comparablePayload(request));
  } catch {
    return UNREPRESENTABLE_DIGEST;
  }
}

const UNREPRESENTABLE_DIGEST = '0'.repeat(64);

const REUSED_FIXES: readonly string[] = [
  'This identity already carries a different request. Use a new operation_id.',
  'The first result stands; returning it for a second payload would hide your bug.',
];

/**
 * A request the register already holds: refused when the body differs, else
 * the stored answer as the rights held now release it. The register row stays
 * as it was: the operation happened, and nothing here repeats it.
 */
async function replay(
  tx: TenantQuery,
  caller: Caller,
  request: IdentifiedRequest,
  digest: string,
  seen: RegisteredAttempt,
  release: (stored: CommandHandle) => Promise<CommandResult | Refused | undefined>,
): Promise<CommandResult> {
  // The command name is part of the compared payload, so one identity used
  // for two different commands differs here without a second comparison. A
  // separate check on `seen.command` could not fail under mutation, so it
  // would be a claim about the digest rather than a check on the request.
  if (seen.payload_digest !== digest) {
    const refusal = refuseCommand('OPERATION_ID_REUSED', [seen.command], REUSED_FIXES);
    // The register already holds this identity, so nothing is written to it.
    return await settle(tx, caller, request, digest, refusal, 'registered');
  }

  // The original result, returned exactly. A caller cannot tell a replay from
  // the first call, which is the point; the chain can, which is also the point.
  const stored = seen.result as unknown as CommandResult;
  // A stored refusal carries nothing protected. A stored success is released
  // only to the rights held now: a revocation bites on the next call, and a
  // replay is a call.
  const released = isCommandRefusal(stored) ? undefined : await release(stored);
  if (released !== undefined && isCommandRefusal(released)) {
    return await settle(tx, caller, request, digest, released, 'registered');
  }
  if (released !== undefined && 'refusal' in released) {
    const { refusal, attempted } = released;
    return await settle(tx, caller, request, digest, refusal, 'registered', attempted);
  }
  await writeAuditEvent(tx, {
    actorId: caller.actorId,
    command: request.command,
    operationId: request.operationId,
    outcome: 'replayed',
    refusalCode: isCommandRefusal(stored) ? stored.code : null,
    subjectRecordId: isCommandRefusal(stored) ? null : stored.recordId,
    payloadDigest: digest,
  });
  return released ?? stored;
}

/**
 * The refusal a stored success answers with now, or nothing when it goes out
 * as stored.
 *
 * The same preparation a fresh call takes, with the target's revision left
 * out: the scope, the R4 rule and the grant decision are the ones the first
 * call answered to, and the revision is the one thing the first call itself
 * moved. Nothing is locked and the handler does not run.
 *
 * A pickup's receipt is its lease, so it is released only while that lease is
 * still the caller's claim, as the agent pickup replay asks (`agent-replay.ts`,
 * step 3).
 */
async function withheldNow(
  tx: TenantQuery,
  session: Session,
  entryPoint: EntryPoint,
  request: UncheckedRequest,
  declaration: CommandDeclaration,
  stored: CommandHandle,
): Promise<Refused | undefined> {
  const prepared = await prepareCommand(tx, session, entryPoint, request, {
    ...declaration,
    targetsExistingRecord: false,
  });
  if ('refusal' in prepared) return prepared;
  if (declaration.name !== 'task.pickup') return undefined;
  return await unboundPickup(tx, session, stored);
}

/**
 * Whether the receipt is still this person's claim, by the step the agent
 * pickup replay takes too (`pickupReceiptBinding`), on a lease no delegation
 * holds.
 */
async function unboundPickup(
  tx: TenantQuery,
  session: Session,
  stored: CommandHandle,
): Promise<Refused | undefined> {
  const binding = await pickupReceiptBinding(tx, {
    holderActorId: session.actorId,
    delegationId: null,
    receipt: stored.detail,
  });
  return 'refusal' in binding ? refused(binding.refusal) : undefined;
}

async function attempt(
  tx: TenantQuery,
  session: Session,
  entryPoint: EntryPoint,
  request: IdentifiedRequest,
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
      await register(tx, session, request, digest, asCallerVisible(outcome.refusal), null);
      const { refusal, attempted } = outcome;
      return await settle(tx, session, request, digest, refusal, 'registered', attempted);
    }
    const handle: CommandHandle = {
      command: request.command,
      recordId: outcome.recordId,
      revision: outcome.revision,
      detail: outcome.detail,
    };
    await register(tx, session, request, digest, handle, outcome.recordId);
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
  request: IdentifiedRequest,
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

/**
 * The preparation and then the command, which is all that is inside the
 * savepoint. The preparation hands back the request parsed against its row's
 * operands, and the command is given that and never the body.
 */
async function work(
  tx: TenantQuery,
  session: Session,
  entryPoint: EntryPoint,
  request: IdentifiedRequest,
  declaration: CommandDeclaration,
): Promise<Applied | Refused> {
  const prepared = await prepareCommand(tx, session, entryPoint, request, declaration);
  if ('refusal' in prepared) return prepared;
  return await handleCommand(tx, prepared, prepared.request);
}

/** One register row for this request, whatever it came to. */
export async function register(
  tx: TenantQuery,
  caller: Caller,
  request: IdentifiedRequest,
  digest: string,
  result: CommandHandle | CommandRefusal,
  recordId: string | null,
): Promise<void> {
  await registerAttempt(tx, {
    operationId: request.operationId,
    command: request.command,
    actorId: caller.actorId,
    digest,
    result,
    recordId,
  });
}

/**
 * Where a refusal's identity stands: `register` writes the register row,
 * `registered` means the register already holds this identity, and `none`
 * that the request carried no usable identity to hold.
 */
export type IdentityStanding = 'register' | 'registered' | 'none';

/**
 * Record the refusal, then hand the caller the version they are allowed to
 * see. The one way a refusal is settled on either prefix.
 */
export async function settle(
  tx: TenantQuery,
  caller: Caller,
  request: UncheckedRequest,
  digest: string,
  refusal: CommandRefusal,
  standing: IdentityStanding = 'register',
  attempted?: Readonly<Record<string, unknown>>,
): Promise<CommandRefusal> {
  // A name can echo a key the caller sent, and `registerAttempt` stores it in
  // the form `storable` gives. The caller is answered with that form, so a
  // replay's bytes are the first answer's.
  const visible = storable(asCallerVisible(refusal));
  const identified = standing !== 'none' && hasIdentity(request) ? request : undefined;
  if (standing === 'register' && identified !== undefined) {
    await register(tx, caller, identified, digest, visible, null);
  }
  await writeAuditEvent(tx, {
    actorId: caller.actorId,
    command: request.command,
    operationId: identified === undefined ? null : identified.operationId,
    outcome: 'refused',
    refusalCode: refusal.code,
    subjectRecordId: null,
    payloadDigest: digest,
    attempted: attempted ?? null,
  });
  return visible;
}
