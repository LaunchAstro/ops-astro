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
import { checkAuthority, subjectsOf, type Refusal } from '../authority/grants.ts';
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
import { refuseReadOperands } from '../commands/operands.ts';
import { writeAuditEvent } from '../commands/audit.ts';
import { payloadDigest } from '../commands/digest.ts';
import {
  planPresetSync,
  type PresetField,
  type PresetPlanRefusal,
} from '../records/preset-plan.ts';
import type { ReadRequest, ReadResult } from './requests.ts';
import {
  isInternalReader,
  readBoard,
  readSharedTask,
  readTaskDetail,
  resolveTaskId,
} from './tasks.ts';
import { listPeople } from './people.ts';
import { readQueue } from './queue.ts';
import { readSettings } from './settings.ts';
import { readCapabilities } from './capabilities.ts';
import { DecisionIntegrityError } from './verified-decisions.ts';

/** The reads an external party is told NOT_FOUND about when its shares do not cover them. */
const OUTSIDER_NOT_FOUND: ReadonlySet<string> = new Set(['task.read', 'task.board']);

/**
 * `session.capabilities` for a caller holding no live grant, in the words
 * `checkAuthority` uses for any operation no grant covers: it is the same
 * refusal, reached by a read with no collection of its own to ask about.
 */
const NO_GRANT_AT_ALL: Refusal = {
  code: 'SCOPE_NOT_GRANTED',
  reason: 'no live grant covers it',
  fix: 'ask a holder who may delegate',
};

/**
 * The identifier fields each read takes (root ruling 3).
 *
 * Two reads are about a record: `task.read` names it by `recordId` and
 * `task.board` names the board. The other five are about the business, and
 * each used to accept a `recordId` and drop it, which is the mistake the
 * command path's `UNTARGETED_IDENTIFIERS` exists to refuse: a body whose
 * identifier the server quietly ignores is a body the caller believes was
 * honoured, and a read that ignored it cannot claim to have looked it up.
 * Keyed by every read name, so a read added to the union is a type error here
 * until someone says what it takes.
 */
const READ_IDENTIFIERS: Readonly<Record<ReadRequest['read'], readonly string[]>> = {
  'task.read': ['recordId'],
  'task.board': ['board'],
  'task.queue': [],
  'person.list': [],
  'preset.plan': [],
  'settings.read': [],
  'session.capabilities': [],
};

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

async function serveRead(
  tx: TenantQuery,
  session: Session,
  request: ReadRequest,
): Promise<ServedRead> {
  // `task.read` names one record and may name it by key, so the identifier is
  // resolved before the grant check and never after it: a record-scoped grant
  // is a grant on a record, not on whichever spelling the caller used. The
  // lookup answers nobody -- a caller with no grant is refused below and
  // learns nothing from it either way -- and an unresolved name is checked at
  // business scope, so "there is no such task" is still answered by the read
  // and never by the authority check.
  const declaration = declarationOf(request.read);
  if (declaration === undefined) {
    throw new Error(`runRead: ${request.read} is not in the command surface`);
  }

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
  const irrelevant = irrelevantIdentifiers(
    request as unknown as Readonly<Record<string, unknown>>,
    READ_IDENTIFIERS[request.read],
  );
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
  const operands = refuseReadOperands(request.read, request as Readonly<Record<string, unknown>>);
  if (operands !== undefined) return { outcome: operands, subjectRecordId: null };
  const needsSpine = request.read === 'task.read' || request.read === 'task.board';
  const spine = needsSpine ? await readTaskSpine(tx) : undefined;
  const recordId =
    request.read === 'task.read' && spine !== undefined
      ? await resolveTaskId(tx, spine.taskTypeId, request.recordId)
      : undefined;

  const served = (outcome: ReadResult | CommandRefusal): ServedRead => ({
    outcome,
    subjectRecordId: recordId ?? null,
  });

  // `session.capabilities` has no collection of its own to hold a grant on:
  // it reports the caller's grants, so it is answered only to a caller who
  // holds at least one. A member with none is refused `SCOPE_NOT_GRANTED` like
  // every other operation (minimum contract 8.2 case 3, ledger I05), and never
  // answered with an empty list, because a denied read is not a success with
  // nothing in it. That refusal is in the case below, where the list is read.
  // A login with no standing never arrives here at all: that is
  // `AUTH_NO_MEMBERSHIP` from the resolution, before any read runs. An
  // external party is shown its shares' pairs. It is skipped here rather than
  // declared grantless because the declaration is what the route generator and
  // the parity test read, and a row missing its collection and action would be
  // a special case in three more places.
  if (request.read !== 'session.capabilities') {
    const authorised = await checkAuthority(tx, subjectsOf(session), {
      // The action is the declaration's. The collection is too for the record
      // reads, and for `preset.plan` it is the family the request names,
      // because that is the grant the plan actually needs: L2's
      // `planPresetSync` checks `manage` on the family of `recordTypeKey`, so
      // a blanket `manage` on `preset` in front of it would be a wider
      // question than the operation asks and a caller holding only it would be
      // let through here and refused there. The declaration's own `preset` is
      // what the route is about rather than what it takes; see
      // `CommandDeclaration.collection`.
      //
      // Today the record type key *is* the family (L2's `familyOf`, private to
      // the planner because it is the one place a real type-to-collection
      // mapping has to land). This is the same key, not a second copy of that
      // mapping: should the two ever differ, the planner still asks its own
      // question afterwards, so this check can only be redundant or narrower --
      // never wider than the authority the plan is granted under.
      collection: request.read === 'preset.plan' ? request.recordTypeKey : declaration.collection,
      action: declaration.action,
      // A record-scoped grant is checked against the record named, exactly as
      // a targeted command's is. A business-scoped grant covers both, which is
      // what `effectiveGrants` already means by `scope_kind = 'business'`.
      scope:
        recordId === undefined ? { kind: 'business', id: null } : { kind: 'record', id: recordId },
    });
    if (!authorised.ok) {
      // An external party (a session with no membership) stands on its shares
      // alone, and minimum contract 8.2 case 7 names what it is told about
      // anything outside them: "Sibling tasks and the board are NOT_FOUND."
      // `SCOPE_NOT_GRANTED` means "in this business, exists, not yours", which
      // is exactly the fact an outsider must not learn about a sibling. A
      // member keeps the in-tenant code (I05); only the outsider's changes.
      if (session.roleKey === null && OUTSIDER_NOT_FOUND.has(request.read)) {
        return served(refuseNotFound());
      }
      return served(fromAuthority(authorised.refusal));
    }
  }

  switch (request.read) {
    case 'task.read': {
      if (recordId === undefined || spine === undefined) return served(refuseNotFound());
      // Internal readers get the detail; everyone else, the external party
      // first among them, gets the shared view, which is built from the
      // catalogue's `shared` fields and never from the detail with parts cut.
      if (!isInternalReader(session.roleKey)) {
        const sharedTask = await readSharedTask(
          tx,
          spine.taskTypeId,
          recordId,
          spine.taskCommentTypeId,
        );
        return served(sharedTask === undefined ? refuseNotFound() : { ok: true, sharedTask });
      }
      const task = await readTaskDetail(tx, spine.taskTypeId, recordId, {
        commentTypeId: spine.taskCommentTypeId,
        internal: true,
      });
      // Not there, or there in another business: one answer, deliberately.
      return served(task === undefined ? refuseNotFound() : { ok: true, task });
    }
    case 'task.board': {
      if (spine === undefined) throw new Error('runRead: task.board reached without the spine');
      // A board is a task record, so one that is not alpha's is refused the
      // way `task.move` refuses it, and never listed as a board with nothing
      // on it: minimum contract 8.2 case 1 asks `NOT_FOUND` for another
      // business's identifier and case 3 says a denied list is never an empty
      // success. Foreign, fabricated, malformed and trashed all get the one
      // answer. `null` is the list of tasks on no board and is not a lookup.
      // An absent operand is not a board either; refusing it is the operand
      // check's job (`commands/operands.ts`), not a lookup's.
      if (
        typeof request.board === 'string' &&
        !(await boardExists(tx, spine.taskTypeId, request.board))
      ) {
        return served(refuseNotFound());
      }
      return served({ ok: true, tasks: await readBoard(tx, spine.taskTypeId, request.board) });
    }
    case 'person.list':
      return served({ ok: true, persons: await listPeople(tx) });
    case 'session.capabilities': {
      // No subject record: see the comment above the authority check. The
      // audit row is written like every other read's (I13), refused or not.
      const capabilities = await readCapabilities(tx, session);
      if (capabilities.grants.length === 0) {
        return served(fromAuthority(NO_GRANT_AT_ALL));
      }
      return served({ ok: true, ...capabilities });
    }
    case 'settings.read':
      // No subject record, for the reason `task.queue` gives: the settings are
      // the business's own configuration rather than one record, and there is
      // no `settings` row in `records` to name in the column even if there
      // were. The audit row is written all the same (I13).
      return served({ ok: true, settings: await readSettings(tx) });
    case 'task.queue':
      // No subject record: the queue is about the business's outstanding work
      // rather than about one task, and naming one of the tasks on it in the
      // audit row would make "who read this record" false for the others.
      return served({ ok: true, queue: await readQueue(tx) });
    case 'preset.plan': {
      // L2's planner checks the same authority again, from its own module, and
      // that repetition is deliberate: the guarantee "this plan was authorised"
      // belongs to the planner whichever surface reaches it, and the guarantee
      // "every operation is authorised before it runs" belongs here. Neither is
      // safe to delete on the strength of the other.
      const planned = await planPresetSync(
        tx,
        { personId: session.personId, actorId: session.actorId },
        {
          recordTypeKey: request.recordTypeKey,
          presetKey: request.presetKey,
          fields: request.fields as readonly PresetField[],
        },
      );
      if (!planned.ok) return served(fromPresetPlan(planned.refusal));
      return served({ ok: true, plan: planned.value });
    }
  }
}

/**
 * The planner's refusal as the command register spells it.
 *
 * The three `PRESET_*` codes are registered here rather than widened into the
 * records register, which is what L2's module comment asks for: a model module
 * reaching into the command surface to add a code is the coupling the register
 * exists to prevent. The mapping is total over
 * `PresetPlanRefusalCode` — `SCOPE_NOT_GRANTED` is already the register's own
 * spelling — so a fourth code added there is a type error here.
 */
function fromPresetPlan(refusal: PresetPlanRefusal): CommandRefusal {
  return refuseCommand(refusal.code, refusal.names, refusal.fixes);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Whether `board` names a live task in the caller's business: `task.move`'s own check. */
async function boardExists(tx: TenantQuery, taskTypeId: string, board: string): Promise<boolean> {
  if (!UUID.test(board)) return false;
  const found = await tx.query<{ readonly id: string }>(
    `select id from records
      where business_id = $1 and record_type_id = $2 and id = $3 and deleted_at is null`,
    [tx.businessId, taskTypeId, board],
  );
  return found.length > 0;
}
