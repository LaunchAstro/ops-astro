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
import { writeAuditEvent } from '../commands/audit.ts';
import { payloadDigest } from '../commands/digest.ts';
import {
  planPresetSync,
  type PresetField,
  type PresetPlanRefusal,
} from '../records/preset-plan.ts';
import type { ReadRequest, ReadResult } from './requests.ts';
import { isInternalReader, readBoard, readTaskDetail, resolveTaskId } from './tasks.ts';
import { listPeople } from './people.ts';
import { readQueue } from './queue.ts';

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
  const served = await serveRead(tx, session, request);
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
  });
  return outcome;
}

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

  const authorised = await checkAuthority(tx, subjectsOf(session), {
    // The action is the declaration's. The collection is too for the three
    // record reads, and for `preset.plan` it is the family the request names,
    // because that is the grant the plan actually needs: L2's `planPresetSync`
    // checks `manage` on the family of `recordTypeKey`, so a blanket `manage`
    // on `preset` in front of it would be a wider question than the operation
    // asks and a caller holding only it would be let through here and refused
    // there. The declaration's own `preset` is what the route is about rather
    // than what it takes; see `CommandDeclaration.collection`.
    //
    // Today the record type key *is* the family (L2's `familyOf`, private to
    // the planner because it is the one place a real type-to-collection
    // mapping has to land). This is the same key, not a second copy of that
    // mapping: should the two ever differ, the planner still asks its own
    // question afterwards, so this check can only be redundant or narrower --
    // never wider than the authority the plan is granted under.
    collection: request.read === 'preset.plan' ? request.recordTypeKey : declaration.collection,
    action: declaration.action,
    // A record-scoped grant is checked against the record named, exactly as a
    // targeted command's is. A business-scoped grant covers both, which is
    // what `effectiveGrants` already means by `scope_kind = 'business'`.
    scope:
      recordId === undefined ? { kind: 'business', id: null } : { kind: 'record', id: recordId },
  });
  if (!authorised.ok) return served(fromAuthority(authorised.refusal));

  switch (request.read) {
    case 'task.read': {
      const task =
        recordId === undefined || spine === undefined
          ? undefined
          : await readTaskDetail(tx, spine.taskTypeId, recordId, {
              commentTypeId: spine.taskCommentTypeId,
              internal: isInternalReader(session.roleKey),
            });
      // Not there, or there in another business: one answer, deliberately.
      return served(task === undefined ? refuseNotFound() : { ok: true, task });
    }
    case 'task.board': {
      if (spine === undefined) throw new Error('runRead: task.board reached without the spine');
      return served({ ok: true, tasks: await readBoard(tx, spine.taskTypeId, request.board) });
    }
    case 'person.list':
      return served({ ok: true, persons: await listPeople(tx) });
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
