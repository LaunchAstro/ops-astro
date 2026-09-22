// SPDX-License-Identifier: AGPL-3.0-only
//
// The command surface: every domain operation, declared once.
//
// This table is the thing the endpoint parity test reads (T1g) and the thing
// the Hono adapter builds its routes from, so an operation that exists and an
// operation that is reachable cannot come apart: adding a row here adds the
// endpoint, and a command with no row has no route to be reached through.
//
// **Why there are more than nine.** The contract names nine (minimum contract
// 4.3) and this part is titled after them. But the task type T1e installed
// names ten *owning operations* on its own field definitions, and minimum
// contract 5.3's fourth assertion requires each of them to exist and be
// reachable through an endpoint — "a protected field whose owning operation
// does not exist is a field nobody can change". Specification 2.2's second
// observable result asks a person to assign a task and move it through stages,
// which are two of those ten. So the owning operations are declared here with
// the nine, and the `contractNine` flag keeps the two sets distinguishable
// rather than merged. The three trash-family operations are here for the same
// reason: specification 14.3 requires the purge to write an audit event, and
// an audit event is written by a command.
//
// **What the flags are for.** `landed` says whether the part this command
// rests on has been built. A command that is declared and not landed still
// runs the whole envelope — identity, revision, audit — and then refuses
// `DEPENDENCY_NOT_LANDED` naming what it waits for. That is deliberate: a
// declared operation with no route would break parity, and a route that
// pretends to work would be worse than either.

import type { Action } from '../authority/grants.ts';

export type CommandName =
  // The contract's nine.
  | 'task.create'
  | 'task.update'
  | 'task.complete'
  | 'task.reopen'
  | 'task.comment'
  | 'task.propose'
  | 'task.decide'
  | 'task.pickup'
  | 'task.handback'
  // The owning operations the task type's field definitions name.
  | 'task.start'
  | 'task.assign'
  | 'task.triage'
  | 'task.set_stage'
  | 'task.set_party'
  | 'task.set_audience'
  | 'task.reparent'
  | 'task.move'
  // The mechanics specification 14.2 and 14.3 name.
  | 'task.rank'
  | 'task.trash'
  | 'task.restore'
  | 'task.purge'
  // The reads. They are here because a read is an operation the same surfaces
  // have to expose, and a table that held only the writes would leave the
  // route for reading a task to be invented somewhere else.
  | 'task.read'
  | 'task.board'
  | 'person.list';

export interface CommandDeclaration {
  readonly name: CommandName;
  /**
   * Whether this operation writes.
   *
   * The draft typed this `mutating: true` and said in a comment that nothing
   * in the surface is a read. That has stopped being true: the local slice
   * needs `task.read`, `task.board` and `person.list`, and declaring them
   * `mutating` so the field could keep its literal type would have made the
   * table lie about the three rows added for the purpose. A read carries no
   * `operation_id` and no `expected_revision`, writes no record and no audit
   * event, and is served by `reads/dispatch.ts` rather than by the command
   * dispatch.
   */
  readonly kind: 'read' | 'write';
  /** Whether it needs an `expected_revision`, which is whether it has a target. */
  readonly targetsExistingRecord: boolean;
  /** The grant action the domain operation checks before it does anything. */
  readonly action: Action;
  /** One of the nine the contract names, as opposed to one the model requires. */
  readonly contractNine: boolean;
  /** False when the table or record type it needs has not landed. */
  readonly landed: boolean;
  /** What it waits for, in words a reader can act on. Empty when it has landed. */
  readonly waitingOn: string;
}

function declare(
  name: CommandName,
  action: Action,
  options: {
    readonly targetsExistingRecord?: boolean;
    readonly contractNine?: boolean;
    readonly waitingOn?: string;
  } = {},
): CommandDeclaration {
  const waitingOn = options.waitingOn ?? '';
  return {
    name,
    kind: 'write',
    targetsExistingRecord: options.targetsExistingRecord ?? true,
    action,
    contractNine: options.contractNine ?? false,
    landed: waitingOn === '',
    waitingOn,
  };
}

/**
 * A read. It takes the `read` action on the collection it names, targets no
 * revision, and is always landed: the records it reads are the ones the
 * commands above already write.
 */
function read(name: CommandName): CommandDeclaration {
  return {
    name,
    kind: 'read',
    targetsExistingRecord: false,
    action: 'read',
    contractNine: false,
    landed: true,
    waitingOn: '',
  };
}

export const COMMAND_SURFACE: readonly CommandDeclaration[] = [
  declare('task.create', 'write', { targetsExistingRecord: false, contractNine: true }),
  declare('task.update', 'write', { contractNine: true }),
  declare('task.complete', 'write', { contractNine: true }),
  declare('task.reopen', 'write', { contractNine: true }),
  declare('task.comment', 'comment', {
    contractNine: true,
    waitingOn: 'a comment record type, which no part of the split owns',
  }),
  declare('task.propose', 'write', {
    contractNine: true,
    waitingOn: 'the gate triple and the budget tables; T1 excludes a proposal',
  }),
  declare('task.decide', 'decide', {
    targetsExistingRecord: false,
    contractNine: true,
    waitingOn: 'the gate triple and a delegations table; T1 excludes a decision',
  }),
  declare('task.pickup', 'write', {
    targetsExistingRecord: false,
    contractNine: true,
    waitingOn: 'a delegations table and a leases table, which no part of the split owns',
  }),
  declare('task.handback', 'write', {
    targetsExistingRecord: false,
    contractNine: true,
    waitingOn: 'a leases table and the gate triple, which no part of the split owns',
  }),

  declare('task.start', 'write'),
  declare('task.assign', 'assign'),
  declare('task.triage', 'write'),
  declare('task.set_stage', 'write'),
  declare('task.set_party', 'share'),
  declare('task.set_audience', 'share'),
  declare('task.reparent', 'write'),
  declare('task.move', 'write'),

  declare('task.rank', 'write'),
  declare('task.trash', 'write'),
  declare('task.restore', 'write', { targetsExistingRecord: false }),
  declare('task.purge', 'manage', { targetsExistingRecord: false }),

  read('task.read'),
  read('task.board'),
  read('person.list'),
];

const BY_NAME = new Map(COMMAND_SURFACE.map((command) => [command.name, command]));

export function declarationOf(name: CommandName): CommandDeclaration | undefined {
  return BY_NAME.get(name);
}

/**
 * The commands with no existing record to be stale against, written out rather
 * than derived from the table above.
 *
 * It was derived once, and a review pointed out that the test comparing the
 * two was comparing a derivation with its source and could not fail. Written
 * by hand, the same test is the check it was meant to be: a declaration and
 * this list that disagree is a failure, and a new exemption is still a diff to
 * this file.
 *
 * `task.create` has no target yet. `task.restore` and `task.purge` take a
 * batch identity and a window, not a record. `task.decide` binds a proposal
 * version rather than a record revision, `task.pickup` mints a lease without
 * writing the task, and  `task.handback` echoes expected versions for
 * everything it touched (minimum contract 4.3). The three reads write nothing,
 * so there is no revision for them to be writing against.
 */
export const NEEDS_NO_EXPECTED_REVISION: ReadonlySet<CommandName> = new Set([
  'person.list',
  'task.board',
  'task.create',
  'task.decide',
  'task.handback',
  'task.pickup',
  'task.purge',
  'task.read',
  'task.restore',
]);

/** The contract's nine, kept separate from the operations the model requires. */
export const CONTRACT_NINE: readonly CommandName[] = COMMAND_SURFACE.filter(
  (command) => command.contractNine,
).map((command) => command.name);

/** Declared, routed, and refusing until the part they rest on lands. */
export const NOT_LANDED: readonly CommandName[] = COMMAND_SURFACE.filter(
  (command) => !command.landed,
).map((command) => command.name);

/** The path the HTTP boundary and the command line both derive from the name. */
export function pathOf(name: CommandName): string {
  return `/${name.replace('.', '/')}`;
}

/** The reads, which no caller may reach through the command envelope. */
export const READS: readonly CommandName[] = COMMAND_SURFACE.filter(
  (command) => command.kind === 'read',
).map((command) => command.name);
