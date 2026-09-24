// SPDX-License-Identifier: AGPL-3.0-only
//
// The read catalogue: every fact about a read, on one row keyed by its name.
//
// A read's facts used to live in ten places across four files: the
// identifiers it takes, whether it needs the task spine, how its authority is
// asked, whether an outsider is told NOT_FOUND, its operand check (a second
// switch in `commands/operands.ts`) and what it serves, with four checks on
// the read's name outside the switch (thermo review b282216, H3). Each is now
// a field of the read's row, and `reads/dispatch.ts` runs one pipeline over
// the row with no branch on the name. It is the read-path twin of the command
// catalogue (`commands/surface.ts`), and keyed by every read name, so a read
// added to the union is a type error here until someone says what it takes.
//
// The grant the read asks, collection and action, stays on its
// `COMMAND_SURFACE` row: that is what the route generator and the surface
// inventory read. This row says only how the check is asked.

import type { TenantQuery } from '../tenancy/database.ts';
import type { Session } from '../identity/login-resolution.ts';
import type { Refusal } from '../authority/grants.ts';
import {
  fromReasoned,
  refuseCommand,
  refuseNotFound,
  type CommandRefusal,
} from '../commands/refusal.ts';
import type { TaskSpine } from '../commands/context.ts';
import {
  planPresetSync,
  type PresetField,
  type PresetPlanRefusal,
} from '../records/preset-plan.ts';
import type { PresetFieldRequest, ReadOperands, ReadRequest, ReadResult } from './requests.ts';
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
import { isUuid } from '../tenancy/ids.ts';
import { invalid, isFieldMap } from '../commands/operands.ts';

export type ReadName = ReadRequest['read'];

/** One read's request, narrowed by name and still unchecked. */
export type ReadOf<K extends ReadName> = ReadRequest & { readonly read: K };

/** A read's body checked: its operands, or the refusal the body earned. */
export type Parsed<K extends ReadName> =
  | { readonly ok: true; readonly operands: ReadOperands[K] }
  | { readonly ok: false; readonly refusal: CommandRefusal };

/** What the pipeline found for a row that reads the spine, before it is served. */
export interface Found {
  readonly spine: TaskSpine;
  /** The one record the read is about, resolved; absent for a business read. */
  readonly recordId: string | undefined;
}

interface RowBase<K extends ReadName> {
  /**
   * The identifier fields the read takes (root ruling 3). Any other is refused
   * `COMMAND_BODY_INVALID`, as on the command path: a body whose identifier
   * the server quietly ignores is a body the caller believes was honoured, and
   * a read that ignored it cannot claim to have looked it up.
   */
  readonly identifiers: readonly string[];
  /**
   * The operands the read cannot be asked without, checked before any lookup
   * so an absent or mistyped one is a refusal and not a fault at a bound
   * parameter (checklist B7), and audited like every other refused read (I13).
   * What it hands back is all the row's later steps are given.
   */
  readonly parse: (body: Readonly<Record<string, unknown>>) => Parsed<K>;
  /**
   * How the grant check is asked. `declared`: the row's own collection and
   * action, at the subject's record scope or the business's. A function: the
   * collection it names instead. `holds-any-grant`: no collection is asked;
   * the read refuses a caller holding nothing (see `session.capabilities`).
   */
  readonly authority: 'declared' | 'holds-any-grant' | ((operands: ReadOperands[K]) => string);
  /**
   * Whether an external party refused by the grant check is told `NOT_FOUND`
   * rather than `SCOPE_NOT_GRANTED` (minimum contract 8.2 case 7: "Sibling
   * tasks and the board are NOT_FOUND"). `SCOPE_NOT_GRANTED` means "in this
   * business, exists, not yours", which is the fact an outsider must not learn
   * about a sibling. A member keeps the in-tenant code (I05).
   */
  readonly outsiderNotFound: boolean;
}

/**
 * A read that needs the installed task type's identifiers. The pipeline reads
 * them before the grant check, and `subject` and `serve` are handed them, so
 * neither has a missing spine to answer (thermo recheck 158d6de, NA2).
 */
export interface SpineRow<K extends ReadName> extends RowBase<K> {
  readonly spine: true;
  /**
   * The one record the read is about, resolved before the grant check and
   * never after it: a record-scoped grant is a grant on a record, not on
   * whichever spelling the caller used. Absent on a read about the business.
   */
  readonly subject?: (
    tx: TenantQuery,
    spine: TaskSpine,
    operands: ReadOperands[K],
  ) => Promise<string | undefined>;
  readonly serve: (
    tx: TenantQuery,
    session: Session,
    operands: ReadOperands[K],
    found: Found,
  ) => Promise<ReadResult | CommandRefusal>;
}

/** A read about the business that needs no spine and names no record. */
export interface BusinessRow<K extends ReadName> extends RowBase<K> {
  readonly spine: false;
  readonly serve: (
    tx: TenantQuery,
    session: Session,
    operands: ReadOperands[K],
  ) => Promise<ReadResult | CommandRefusal>;
}

export type ReadRow<K extends ReadName> = SpineRow<K> | BusinessRow<K>;

/**
 * An array of field maps. That is all a read checks of a preset's fields: the
 * keys each one carries are the planner's to refuse, in its own words, so the
 * narrowing to `PresetFieldRequest` is the wire's promise and not this check's.
 */
function isFieldList(value: unknown): value is readonly PresetFieldRequest[] {
  return Array.isArray(value) && value.every(isFieldMap);
}

/** A body refused on one operand, in the command path's words (`commands/operands.ts`). */
function rejected(
  name: string,
  fix: string,
): { readonly ok: false; readonly refusal: CommandRefusal } {
  return { ok: false, refusal: invalid(name, fix) };
}

function parsed<T>(operands: T): { readonly ok: true; readonly operands: T } {
  return { ok: true, operands };
}

const NONE = (): { readonly ok: true; readonly operands: Readonly<Record<never, never>> } =>
  parsed({});

/** The planner reads each preset field as an object; which keys it needs is its own question. */
const PRESET_FIELDS_FIX = 'Send fields as an array of field objects, which may be empty.';

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

export const READ_CATALOGUE: { readonly [K in ReadName]: ReadRow<K> } = {
  'task.read': {
    identifiers: ['recordId'],
    parse: ({ recordId }) =>
      typeof recordId === 'string'
        ? parsed({ recordId })
        : rejected('recordId', 'Send recordId as the task’s identifier or its key.'),
    spine: true,
    // The lookup answers nobody: a caller with no grant is refused after it
    // and learns nothing from it either way, and an unresolved name is checked
    // at business scope, so "there is no such task" is still answered by the
    // read and never by the authority check.
    subject: (tx, spine, operands) => resolveTaskId(tx, spine.taskTypeId, operands.recordId),
    authority: 'declared',
    outsiderNotFound: true,
    async serve(tx, session, _operands, { spine, recordId }) {
      if (recordId === undefined) return refuseNotFound();
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
        return sharedTask === undefined ? refuseNotFound() : { ok: true, sharedTask };
      }
      const task = await readTaskDetail(tx, spine.taskTypeId, recordId, {
        commentTypeId: spine.taskCommentTypeId,
        internal: true,
      });
      // Not there, or there in another business: one answer, deliberately.
      return task === undefined ? refuseNotFound() : { ok: true, task };
    },
  },
  'task.board': {
    identifiers: ['board'],
    // `null` is a real board: the list of tasks on none. An absent key is
    // not, and answering it with that list gave a body that asked nothing
    // the answer to a question it never put (I14-SEAM U1). A string is
    // looked up, and refused `NOT_FOUND` there if it names nothing here.
    parse: ({ board }) =>
      typeof board === 'string' || board === null
        ? parsed({ board })
        : rejected(
            'board',
            'Send board as a board task’s identifier, or null for tasks on no board.',
          ),
    spine: true,
    authority: 'declared',
    outsiderNotFound: true,
    async serve(tx, _session, operands, { spine }) {
      // A board is a task record, so one that is not alpha's is refused the
      // way `task.move` refuses it, and never listed as a board with nothing
      // on it: minimum contract 8.2 case 1 asks `NOT_FOUND` for another
      // business's identifier and case 3 says a denied list is never an empty
      // success. Foreign, fabricated, malformed and trashed all get the one
      // answer. `null` is the list of tasks on no board and is not a lookup.
      if (
        typeof operands.board === 'string' &&
        !(await boardExists(tx, spine.taskTypeId, operands.board))
      ) {
        return refuseNotFound();
      }
      return { ok: true, tasks: await readBoard(tx, spine.taskTypeId, operands.board) };
    },
  },
  'person.list': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'declared',
    outsiderNotFound: false,
    serve: async (tx) => ({ ok: true, persons: await listPeople(tx) }),
  },
  // No subject record: the queue is about the business's outstanding work
  // rather than about one task, and naming one of the tasks on it in the
  // audit row would make "who read this record" false for the others.
  'task.queue': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'declared',
    outsiderNotFound: false,
    serve: async (tx) => ({ ok: true, queue: await readQueue(tx) }),
  },
  'preset.plan': {
    identifiers: [],
    parse({ recordTypeKey, presetKey, fields }) {
      if (typeof recordTypeKey !== 'string' || recordTypeKey === '') {
        return rejected('recordTypeKey', 'Send recordTypeKey as a non-empty string.');
      }
      if (typeof presetKey !== 'string' || presetKey === '') {
        return rejected('presetKey', 'Send presetKey as a non-empty string.');
      }
      if (!isFieldList(fields)) return rejected('fields', PRESET_FIELDS_FIX);
      return parsed({ recordTypeKey, presetKey, fields });
    },
    spine: false,
    // The collection is the family the request names, because that is the
    // grant the plan actually needs: L2's `planPresetSync` checks `manage` on
    // the family of `recordTypeKey`, so a blanket `manage` on `preset` in
    // front of it would be a wider question than the operation asks and a
    // caller holding only it would be let through here and refused there. The
    // declaration's own `preset` is what the route is about rather than what
    // it takes; see `CommandDeclaration.collection`.
    //
    // Today the record type key *is* the family (L2's `familyOf`, private to
    // the planner because it is the one place a real type-to-collection
    // mapping has to land). This is the same key, not a second copy of that
    // mapping: should the two ever differ, the planner still asks its own
    // question afterwards, so this check can only be redundant or narrower --
    // never wider than the authority the plan is granted under.
    authority: (operands) => operands.recordTypeKey,
    outsiderNotFound: false,
    async serve(tx, session, operands) {
      // L2's planner checks the same authority again, from its own module, and
      // that repetition is deliberate: the guarantee "this plan was authorised"
      // belongs to the planner whichever surface reaches it, and the guarantee
      // "every operation is authorised before it runs" belongs here. Neither is
      // safe to delete on the strength of the other.
      const planned = await planPresetSync(
        tx,
        { personId: session.personId, actorId: session.actorId },
        {
          recordTypeKey: operands.recordTypeKey,
          presetKey: operands.presetKey,
          fields: operands.fields as readonly PresetField[],
        },
      );
      if (!planned.ok) return fromPresetPlan(planned.refusal);
      return { ok: true, plan: planned.value };
    },
  },
  // No subject record, for the reason `task.queue` gives: the settings are
  // the business's own configuration rather than one record, and there is no
  // `settings` row in `records` to name in the column even if there were.
  'settings.read': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'declared',
    outsiderNotFound: false,
    serve: async (tx) => ({ ok: true, settings: await readSettings(tx) }),
  },
  // `session.capabilities` has no collection of its own to hold a grant on:
  // it reports the caller's grants, so it is answered only to a caller who
  // holds at least one. A member with none is refused `SCOPE_NOT_GRANTED` like
  // every other operation (minimum contract 8.2 case 3, ledger I05), and never
  // answered with an empty list, because a denied read is not a success with
  // nothing in it. A login with no standing never arrives here at all: that is
  // `AUTH_NO_MEMBERSHIP` from the resolution, before any read runs. An
  // external party is shown its shares' pairs. The declaration keeps its
  // collection and action because the route generator and the surface
  // inventory read them, and a row missing half its shape would be a special case in
  // three more places.
  'session.capabilities': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'holds-any-grant',
    outsiderNotFound: false,
    async serve(tx, session) {
      const capabilities = await readCapabilities(tx, session);
      if (capabilities.grants.length === 0) return fromReasoned(NO_GRANT_AT_ALL);
      return { ok: true, ...capabilities };
    },
  },
};

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

/** Whether `board` names a live task in the caller's business: `task.move`'s own check. */
async function boardExists(tx: TenantQuery, taskTypeId: string, board: string): Promise<boolean> {
  if (!isUuid(board)) return false;
  const found = await tx.query<{ readonly id: string }>(
    `select id from records
      where business_id = $1 and record_type_id = $2 and id = $3 and deleted_at is null`,
    [tx.businessId, taskTypeId, board],
  );
  return found.length > 0;
}
