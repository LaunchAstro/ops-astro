// SPDX-License-Identifier: AGPL-3.0-only
//
// What a handler hands back to the envelope.
//
// A refusal is a value here rather than an exception, all the way down: the
// envelope has to be able to roll the handler's writes back and then record
// the refusal, and an exception would have taken the transaction with it. The
// two shapes are separate types rather than one union with a flag so that a
// handler cannot return a half-filled result and have it read as applied.

import type { DataWrite } from '../../../core-records/src/index.ts';
import type { CommandName } from '../../../core-wire/src/index.ts';
import type { CommandRefusal } from './refusal.ts';

/**
 * The names of the fields an applied write actually changed, for its audit
 * event (P20, `audit_events.field_changes`). Names only, never a value; `[]`
 * is a write that changed nothing. Absent means unknown, not unchanged.
 */
export interface FieldChanges {
  readonly version: 1;
  readonly keys: readonly string[];
}

/**
 * Every command that owns a task field, and so records `FieldChanges` on its
 * applied audit event (P21). The column's constraint (migration
 * 20261011034325) lists the same commands; `field-writers.test.ts` fails when
 * the two lists or the handlers drift apart.
 */
export const FIELD_WRITES: readonly CommandName[] = [
  'task.update',
  'task.assign',
  'task.set_stage',
  'task.set_party',
  'task.set_scores',
  'task.set_adhoc',
  'task.set_category',
  'task.triage',
  'task.set_audience',
  'map.scope',
  'task.start',
  'task.complete',
  'task.reopen',
  'task.cancel',
  'task.restart',
  'task.set_state',
  'task.move',
  'task.reparent',
  'task.rank',
  'task.set_type',
  'task.claim',
  'task.set_blocking',
  'task.resolve',
  'task.close_out_of_scope',
];

export interface Applied {
  /** The record the command touched, or null where it touched no single one. */
  readonly recordId: string | null;
  /** The revision the caller may write against next. */
  readonly revision: number | null;
  /** What the command did, in values a client can read. Never the record. */
  readonly detail: Readonly<Record<string, unknown>>;
  /** The caller's own conversation a created task came from, for its audit event's origin (AW-03). */
  readonly originConversationId?: string;
  /**
   * The record the audit event names, where it is not `recordId`: a promote or
   * demote answers the class (the revision the caller writes against) and its
   * audit event names the mandate it filed or revoked (MP-14-10a).
   */
  readonly auditSubjectId?: string;
  /** Set only by a field writer: what its write changed (`appliedWrite`), or none (`appliedUnwritten`). */
  readonly fieldChanges?: FieldChanges;
}

export interface Refused {
  readonly refusal: CommandRefusal;
  /**
   * The keys and values an attempt carried that it was not allowed to carry.
   * They go to the audit event and never to the response (T1-N4). Only the
   * offending keys: this is not a place to keep the payload.
   */
  readonly attempted?: Readonly<Record<string, unknown>>;
  /**
   * A refusal that wrote something the contract keeps.
   *
   * The ordinary rule is that a refusal leaves nothing behind, and it is held
   * by rolling the handler's savepoint back. `task.handback` is the exception,
   * under the runtime's R4: a stale holder's work was still really done, so the
   * runtime writes an append-only `handback_reports` row and *then* refuses,
   * and rolling that back would throw away the evidence the refusal exists to
   * preserve. The flag is on the refusal rather than on a list of codes
   * somewhere else, because the handler that wrote the row is the only thing
   * that knows it did.
   */
  readonly retains?: true;
  /**
   * The refusal as the register keeps it, when the answer names what only the
   * caller's rights at the time may see: a refused mention names a person to
   * an author who may see them, and keeps each one by the identifier as sent
   * (OW-037.1); or when it is about the session that sent it, which a replay
   * from a later sign-in does not share (a C52-A change whose session ended).
   * A replay answers the kept form, so a stored refusal carries nothing
   * protected.
   */
  readonly kept?: CommandRefusal;
}

export type HandlerOutcome = Applied | Refused;

export function applied(
  recordId: string | null,
  revision: number | null,
  detail: Readonly<Record<string, unknown>> = {},
): Applied {
  return { recordId, revision, detail };
}

/** The applied answer for a data write, carrying the keys it actually changed. */
export function appliedWrite(
  recordId: string,
  write: DataWrite,
  detail: Readonly<Record<string, unknown>> = {},
): Applied {
  return {
    ...applied(recordId, write.revision, detail),
    fieldChanges: { version: 1, keys: write.changed },
  };
}

/** The applied answer for a field writer that writes no field of its task: none changed. */
export function appliedUnwritten(
  recordId: string,
  detail: Readonly<Record<string, unknown>> = {},
): Applied {
  return { ...applied(recordId, null, detail), fieldChanges: { version: 1, keys: [] } };
}

export function refused(
  refusal: CommandRefusal,
  attempted?: Readonly<Record<string, unknown>>,
): Refused {
  return attempted === undefined ? { refusal } : { refusal, attempted };
}

/**
 * A refusal whose writes are kept. See `Refused.retains`; the only caller is
 * `task.handback` on the two paths where the runtime retained a report.
 */
export function refusedRetaining(
  refusal: CommandRefusal,
  attempted?: Readonly<Record<string, unknown>>,
): Refused {
  return attempted === undefined
    ? { refusal, retains: true }
    : { refusal, retains: true, attempted };
}

export function isRefused(outcome: HandlerOutcome): outcome is Refused {
  return 'refusal' in outcome;
}
