// SPDX-License-Identifier: AGPL-3.0-only
//
// Which read a name becomes, and everything that has to be true before it runs.
//
// The order is the commands' order, for the commands' reason. Authority first,
// so a caller with no grant learns nothing about whether the record exists; the
// read after it, so "denied" and "not there" are answered by different code
// paths and cannot be confused for each other.
//
// The switch is here rather than inline in `execute.ts` because
// `surfaces/exported.ts` reads the operation surface out of the dispatch files
// rather than out of the declaration table -- a read declared with nothing to
// serve it would otherwise pass parity.

import type { TenantQuery } from '../tenancy/database.ts';
import type { Session } from '../identity/login-resolution.ts';
import { checkAuthority, subjectsOf } from '../authority/grants.ts';
import {
  fromAuthority,
  refuseCommand,
  refuseNotFound,
  type CommandRefusal,
} from '../commands/refusal.ts';
import { readTaskSpine } from '../commands/context.ts';
import { declarationOf } from '../commands/surface.ts';
import {
  SYSTEM_OWNED_FIXES,
  claimedSystemFields,
  irrelevantIdentifiers,
} from '../commands/prepare.ts';
import { writeAuditEvent } from '../commands/audit.ts';
import { payloadDigest } from '../commands/digest.ts';
import type { ReadRequest, ReadResult } from './requests.ts';
import { READ_CATALOGUE, type ReadName, type ReadOf, type ReadRow } from './catalogue.ts';
import { DecisionIntegrityError } from './verified-decisions.ts';

const READ_BODY_FIXES: readonly string[] = [
  'Send only the fields this read declares.',
  'A read about the business rather than one record takes no record identifier.',
];

/**
 * Every read, audited, in the caller's own transaction (I13).
 *
 * `commands/surface.ts` used to say a read writes no audit event and it now
 * says the opposite, because the accepted ledger asks for every successful and
 * refused production operation to be audited and a read that leaves no trace
 * is the one way to look at a business's work without the business learning it
 * happened. The event is the same shape the commands write, through the same
 * `writeAuditEvent`, so the chain has one kind of row in it and the hash
 * covers a read exactly as it covers a write.
 *
 * `operation_id` is null: a read has nothing to replay, so there is no
 * identity to hold and inventing one would put a row in the register for
 * something that was never an attempt. The column is nullable for the refusals
 * that arrive before an identity, and this is the second thing it carries.
 *
 * It is written after the read rather than before it so the outcome is the
 * outcome, and inside the same transaction so an audited read and its answer
 * commit together or neither does.
 */
export async function runRead(
  tx: TenantQuery,
  session: Session,
  request: ReadRequest,
): Promise<ReadResult | CommandRefusal> {
  let served: ServedRead;
  try {
    served = await serveRead(tx, session, request);
  } catch (cause) {
    if (cause instanceof DecisionIntegrityError) throw new ReadIntegrityFault(cause);
    throw cause;
  }
  const outcome = served.outcome;
  const refusal = 'refused' in outcome ? outcome : undefined;
  await writeAuditEvent(tx, {
    actorId: session.actorId,
    command: request.read,
    operationId: null,
    outcome: refusal === undefined ? 'applied' : 'refused',
    refusalCode: refusal?.code ?? null,
    subjectRecordId: served.subjectRecordId,
    payloadDigest: payloadDigest(request),
    // The values a spoof attempt carried, and only on the attempt that carried
    // them. They are here and nowhere else: naming the keys tells the author
    // what to remove, and echoing the values back would confirm to a prober
    // that the server read what it sent (T1-N4).
    attempted: served.attempted ?? null,
  });
  return outcome;
}

/**
 * A read whose stored decisions did not verify, answered as the fault it is.
 *
 * Not a refusal: nothing the caller sent was wrong and nothing they can change
 * will make it pass, so it carries no `refused` flag and no register code's
 * status. Not `SERVICE_UNAVAILABLE` either, whose fix is "retry": a tampered
 * or incomplete chain answers the same way every time until an operator looks
 * at it. So it has its own code, `DECISION_INTEGRITY`, under 500.
 *
 * The body carries the code and fixed words only. Where the chain broke --
 * a sequence number, a key id, a gate -- stays in `message` for the server's
 * log, because the body is shown to whoever asked and a stored value in it
 * tells a prober what the database holds.
 *
 * The transaction ends with the throw, so the read's audit row is rolled back
 * with everything else in it and none is written. Nothing is repaired either:
 * the stored rows are the evidence and stay as they were found.
 *
 * `getResponse` is the shape Hono's error handler answers with, which is how
 * the fault reaches HTTP without the read knowing about the transport.
 */
export class ReadIntegrityFault extends Error {
  readonly code = 'DECISION_INTEGRITY';
  readonly status = 500;

  constructor(cause: DecisionIntegrityError) {
    super(cause.message, { cause });
    this.name = 'ReadIntegrityFault';
  }

  getResponse(): Response {
    return Response.json(
      { code: this.code, names: [], fixes: INTEGRITY_FIXES },
      { status: this.status },
    );
  }
}

const INTEGRITY_FIXES: readonly string[] = [
  'The stored decisions on this task did not verify, so none of it was shown.',
  'Nothing was changed. Retrying will give the same answer; report it to the operator.',
];

/**
 * A read's answer and the record it was about.
 *
 * The two travel together because the audit row needs the second and the
 * caller needs the first, and the identifier the caller *presented* is not
 * the one the audit column takes: `task.read` may name a task by its key, and
 * `audit_events.subject_record_id` is a uuid. Writing the presented name into
 * it made the column raise `invalid input syntax for type uuid` and turned an
 * ordinary read by key into a 503, which is the defect this shape removes.
 *
 * It is `null` when nothing resolved -- an unknown key, or a read that is
 * about no single record at all. Null is the honest answer there: the read
 * happened and it looked at nothing, and inventing an identifier to fill the
 * column would make "who read this record" false.
 */
interface ServedRead {
  readonly outcome: ReadResult | CommandRefusal;
  readonly subjectRecordId: string | null;
  /** Only the system-owned keys a payload claimed, with their values. */
  readonly attempted?: Readonly<Record<string, unknown>> | undefined;
}

async function serveRead<K extends ReadName>(
  tx: TenantQuery,
  session: Session,
  request: ReadOf<K>,
): Promise<ServedRead> {
  const declaration = declarationOf(request.read);
  if (declaration === undefined) {
    throw new Error(`runRead: ${request.read} is not in the command surface`);
  }
  const row: ReadRow<K> = READ_CATALOGUE[request.read];
  const body = request as Readonly<Record<string, unknown>>;

  // D06, on the read half, with the commands' own list and the commands' own
  // code. A read takes no command envelope, so `prepareCommand` never sees it
  // and the keys used to be dropped in silence -- which is the answer the
  // accepted ledger rules out: a caller who believed they had set `actor_id`
  // got a `200` and no correction, so the mistake lived in their client and
  // this server looked fine. It is first, before the spine is read and before
  // authority, because nothing about the business has been read yet and a
  // caller learns only that the field they sent is not theirs to send.
  // The installed system fields' keys are refused with them (root ruling 1).
  const claimed = await claimedSystemFields(tx, request);
  if (claimed !== undefined) {
    return {
      outcome: refuseCommand('FIELD_NOT_WRITABLE', claimed.keys, SYSTEM_OWNED_FIXES),
      subjectRecordId: null,
      attempted: claimed.values,
    };
  }
  // A target the read does not take is refused next, `COMMAND_BODY_INVALID`
  // as on the command path, before anything is looked up: the refusal is the
  // same for an own, a foreign and a fabricated identifier, so it tells the
  // caller nothing about any of them.
  const irrelevant = irrelevantIdentifiers(body, row.identifiers);
  if (irrelevant.length > 0) {
    return {
      outcome: refuseCommand('COMMAND_BODY_INVALID', irrelevant, READ_BODY_FIXES),
      subjectRecordId: null,
    };
  }
  // An absent or mistyped operand is refused next, before it reaches a bound
  // parameter and answers a fault (checklist B7). It used to be refused at the
  // HTTP boundary, which left a refused read with no audit row; here it is
  // audited like every other refused read (I13).
  const operands = row.operands(body);
  if (operands !== undefined) return { outcome: operands, subjectRecordId: null };
  const spine = row.spine ? await readTaskSpine(tx) : undefined;
  const recordId =
    row.subject !== undefined && spine !== undefined
      ? await row.subject(tx, spine, request)
      : undefined;

  const served = (outcome: ReadResult | CommandRefusal): ServedRead => ({
    outcome,
    subjectRecordId: recordId ?? null,
  });

  if (row.authority !== 'holds-any-grant') {
    const authorised = await checkAuthority(tx, subjectsOf(session), {
      // The action is the declaration's, and so is the collection unless the
      // row names the one the request is really about (`preset.plan`).
      collection: row.authority === 'declared' ? declaration.collection : row.authority(request),
      action: declaration.action,
      // A record-scoped grant is checked against the record named, exactly as
      // a targeted command's is. A business-scoped grant covers both, which is
      // what `effectiveGrants` already means by `scope_kind = 'business'`.
      scope:
        recordId === undefined ? { kind: 'business', id: null } : { kind: 'record', id: recordId },
    });
    if (!authorised.ok) {
      // An external party is a session with no membership (`ReadRow.outsiderNotFound`).
      if (session.roleKey === null && row.outsiderNotFound) return served(refuseNotFound());
      return served(fromAuthority(authorised.refusal));
    }
  }

  return served(await row.serve(tx, session, request, { spine, recordId }));
}
