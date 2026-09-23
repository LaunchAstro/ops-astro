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
  const outcome = await serveRead(tx, session, request);
  const refusal = 'refused' in outcome ? outcome : undefined;
  await writeAuditEvent(tx, {
    actorId: session.actorId,
    command: request.read,
    operationId: null,
    outcome: refusal === undefined ? 'applied' : 'refused',
    refusalCode: refusal?.code ?? null,
    subjectRecordId: request.read === 'task.read' ? request.recordId : null,
    payloadDigest: payloadDigest(request),
  });
  return outcome;
}

async function serveRead(
  tx: TenantQuery,
  session: Session,
  request: ReadRequest,
): Promise<ReadResult | CommandRefusal> {
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

  const authorised = await checkAuthority(tx, subjectsOf(session), {
    // Both from the declaration. `preset.plan` asks for `manage` on presets
    // and the other three for `read` on their own collection, and neither is
    // written out here: see `CommandDeclaration.collection`.
    collection: declaration.collection,
    action: declaration.action,
    // A record-scoped grant is checked against the record named, exactly as a
    // targeted command's is. A business-scoped grant covers both, which is
    // what `effectiveGrants` already means by `scope_kind = 'business'`.
    scope:
      recordId === undefined ? { kind: 'business', id: null } : { kind: 'record', id: recordId },
  });
  if (!authorised.ok) return fromAuthority(authorised.refusal);

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
      return task === undefined ? refuseNotFound() : { ok: true, task };
    }
    case 'task.board': {
      if (spine === undefined) throw new Error('runRead: task.board reached without the spine');
      return { ok: true, tasks: await readBoard(tx, spine.taskTypeId, request.board) };
    }
    case 'person.list':
      return { ok: true, persons: await listPeople(tx) };
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
      if (!planned.ok) return fromPresetPlan(planned.refusal);
      return { ok: true, plan: planned.value };
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
