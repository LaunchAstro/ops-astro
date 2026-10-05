// SPDX-License-Identifier: AGPL-3.0-only
//
// The shape of one row of the command surface, moved whole from `surface.ts`
// to keep that file under the 1,000-line limit for product source.
// `surface.ts` declares the rows and re-exports this type.

import type { Action } from '../../core-records/src/index.ts';
import type { CommandName } from './command-names.ts';
import type { OperandSpec } from './write-operands.ts';

export interface CommandDeclaration {
  readonly name: CommandName;
  /**
   * Whether this operation writes.
   *
   * Not the literal `true`: the local slice serves `task.read`, `task.board`
   * and `person.list` from this table, and declaring them `mutating` would
   * make the table lie about them. A read carries no
   * `operation_id` and no `expected_revision` and writes no record, and it is
   * served by `reads/dispatch.ts` rather than by the command dispatch.
   *
   * **A read does write an audit event.** I13 is explicit that every
   * successful *and* refused production operation
   * is audited — a read that leaves no trace is the one way to look at a
   * business's work without the business ever learning it happened. So
   * `reads/dispatch.ts` writes one event per read, of the same shape the
   * commands write, with a null `operation_id` because a read has nothing to
   * replay.
   */
  readonly kind: 'read' | 'write';
  /**
   * The collection the grant model is asked about.
   *
   * It is on the declaration rather than in the envelope because the envelope
   * had `'task'` written into it, which was true while every operation was a
   * task operation and became a silent widening the moment one was not: a
   * caller holding `manage` on tasks would have been handed the preset planner
   * and the settings commands for free. The collection and the action are one
   * decision and they now live in one place.
   */
  readonly collection: string;
  /** Whether it needs an `expected_revision`, which is whether it has a target. */
  readonly targetsExistingRecord: boolean;
  /**
   * What the authority check is asked about, separately from revision and
   * locking, which one flag cannot decide for both.
   *
   * - `record`: the task the body names in `recordId`, so a record- or
   *   party-scoped grant on that task answers it. Work control names its task
   *   without writing it, so it is `record` with no revision.
   * - `business`: the business as a whole; nothing in the body is the target.
   * - `target`: the row the command revokes (a grant, a delegation), asked at
   *   that row's own scope. A business-wide check would refuse a manager whose
   *   authority is exactly the target's scope; the handler then asks the full
   *   ceiling against the same row.
   * - `claim`: the task the body's reservation or lease belongs to, so a
   *   record-scoped writer works their own lease on that task. Own-lease work
   *   names its task only through the claim and writes no task revision.
   * - `self`: the caller's own account or rows. No grant row is asked: the
   *   catalogue gives every signed-in person this action on their own account
   *   and rows and on nobody else's (`account:write`, C23; a self-scoped key
   *   such as `preference:write`). A command takes no identifier that could
   *   name another; an inbox operation reaches no row but the caller's, and
   *   asks access per row.
   */
  readonly authorisedOn: 'record' | 'business' | 'target' | 'claim' | 'self';
  /**
   * Whether an applied attempt, the replay of one, or a successful read joins
   * the audit chain. False only where the capability row says the action is
   * not audited: saving and reading a person's own preferences (CS-2.8). A
   * refused attempt joins it on every row, so a probe stays visible.
   */
  readonly audited: boolean;
  /**
   * Who locks a targeted task. `command`: the envelope locks it and compares
   * the revision before the handler runs, the ordinary task-write path.
   * `runtime`: the operation's own ordered lock set takes the task after the
   * cap and envelope (TRANSACTION-CONTRACT line 9), so the envelope only reads
   * it, and the handler compares the revision once those locks are held.
   */
  readonly targetLock: 'command' | 'runtime';
  /**
   * A per-business advisory lock the envelope takes before it locks the
   * target, for commands that rewrite a subtree's parent links or boards
   * (`task.reparent`, `task.move`). The widest lock goes first
   * (TRANSACTION-CONTRACT lock order; core-runtime `locks.ts`, the chain
   * class), so no two of them ever hold a task row while waiting for it: the
   * order is this lock, then the target, then the parent and the subtree.
   * Absent on every other command.
   */
  readonly serialise?: string;
  /** The grant action the domain operation checks before it does anything. */
  readonly action: Action;
  /**
   * The identifier fields an untargeted write may carry. Any other identifier
   * in its body is refused `COMMAND_BODY_INVALID` rather than ignored
   * (`prepare.ts`, `refuseIrrelevantTarget`), so a request type that grows an
   * identifier has to be named here rather than being silently covered.
   *
   * Absent on a targeted write, whose
   * `recordId` *is* its target and is checked by reading it, and on a read,
   * which `reads/dispatch.ts` checks against its own list.
   */
  readonly untargetedIdentifiers?: readonly string[];
  /**
   * The identifier the runtime handler shapes itself (`isIdentifier`) and
   * answers in its own code, RESERVATION_NOT_CLAIMABLE or LEASE_NOT_OWNED, byte
   * for byte as it answers a fabricated one. `prepare.ts` leaves that one field
   * alone: a generic NOT_FOUND there would tell the two apart.
   */
  readonly runtimeShaped?: string;
  /**
   * Whether an agent login may reach it: `never`, only under a delegation, or
   * also `before-pickup`, when it holds nothing yet (minimum contract 8.2).
   */
  readonly agent: 'never' | 'delegated' | 'before-pickup';
  /**
   * The body fields a command takes beyond its identity and its expected
   * revision, each with the JSON kind it must arrive as. The envelope parses a
   * body against this once, into the typed request or a refusal, before any
   * command code runs. A read describes its operands on its catalogue row
   * (`reads/catalogue.ts`), so it carries none here.
   */
  readonly operands?: OperandSpec;
  // two-part keys (API-1); the handler checks past `action`
  readonly authority?: readonly string[];
  // a hold every path keeps, carried onto the catalogue row (API-1)
  readonly rule?: string;
}
