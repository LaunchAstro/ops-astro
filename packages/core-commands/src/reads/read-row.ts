// SPDX-License-Identifier: AGPL-3.0-only
//
// A read catalogue row's shape, moved whole from `catalogue.ts` to keep it
// under its line cap; `catalogue.ts` re-exports it. Types only.

import type { TenantQuery, Session } from '../../../core-records/src/index.ts';
import type { CommandRefusal } from '../commands/refusal.ts';
import type { TaskSpine } from '../commands/context.ts';
import type { ReadOperands, ReadRequest, ReadResult } from './requests.ts';

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
   * `declared-within`: a list read. For an external party, as `declared`.
   * For a member, the row's `serve` decides from one read of their grants:
   * a business grant answers every record with the withheld count (B-22), a
   * grant on some records answers those and no count (a client login, owner
   * answer 22), no grant is refused.
   * `self`: no grant is asked; the answer is about the caller alone and names
   * nobody else (`session.person`), or serves the caller's own rows only and
   * derives access on each (the inbox).
   */
  readonly authority:
    | 'declared'
    | 'declared-within'
    | 'holds-any-grant'
    | 'self'
    | ((operands: ReadOperands[K]) => string);
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
 * neither has a missing spine to answer.
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
  /**
   * The row's own gate, asked after the grant and before `serve`: false is
   * `NOT_FOUND`. It is apart from `serve` so a check that shows the person
   * nothing can ask it without serving (`admitRead`).
   */
  readonly admits?: (tx: TenantQuery, session: Session, found: Found) => Promise<boolean>;
  /**
   * A list read's admission (`declared-within`), which its `serve` decides
   * from the read of the caller's grants: the refusal `serve` would answer,
   * or none. Apart from `serve` so `admitRead` refuses what the read refuses
   * without serving it.
   */
  readonly listRefusal?: (
    tx: TenantQuery,
    session: Session,
    operands: ReadOperands[K],
    found: Found,
  ) => Promise<CommandRefusal | undefined>;
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
