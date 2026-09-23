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
  | 'task.queue'
  | 'person.list'
  // The preset planner. It reads the model and writes nothing at all, so it is
  // a read by the only definition this table has; what makes it unlike the
  // other three is the authority it asks for, which is `manage` on presets
  // rather than `read` on a collection of records.
  | 'preset.plan'
  // The business's own settings, projected. Four landed contracts name a
  // per-business setting and none of them could read one through a surface,
  // so the values were writable and invisible. It is a read on the `settings`
  // collection, which is the same collection the two commands below write.
  | 'settings.read'
  // What the caller may do here, from the live grant model. It is the one row
  // whose answer is about the caller rather than about the business, which is
  // why it takes no grant beyond membership: every pair in it is a pair the
  // caller already holds, so returning them confers nothing.
  | 'session.capabilities'
  // The two settings the model classifies `operation`. A setting that decides
  // who must agree before money moves or before work completes is an authority
  // change wearing configuration's clothes, so it is not reachable through a
  // generic edit and a named command owns it. The names are the ones the
  // `business_settings` rows already cite in `owning_operation`.
  | 'settings.set_four_eyes_threshold'
  | 'settings.set_client_sign_off';

export interface CommandDeclaration {
  readonly name: CommandName;
  /**
   * Whether this operation writes.
   *
   * The draft typed this `mutating: true` and said in a comment that nothing
   * in the surface is a read. That has stopped being true: the local slice
   * needs `task.read`, `task.board` and `person.list`, and declaring them
   * `mutating` so the field could keep its literal type would have made the
   * table lie about the rows added for the purpose. A read carries no
   * `operation_id` and no `expected_revision` and writes no record, and it is
   * served by `reads/dispatch.ts` rather than by the command dispatch.
   *
   * **A read does write an audit event.** This comment said it wrote none, and
   * I13 is explicit that every successful *and* refused production operation
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
    readonly collection?: string;
    readonly targetsExistingRecord?: boolean;
    readonly contractNine?: boolean;
    readonly waitingOn?: string;
  } = {},
): CommandDeclaration {
  const waitingOn = options.waitingOn ?? '';
  return {
    name,
    kind: 'write',
    collection: options.collection ?? TASK_COLLECTION,
    targetsExistingRecord: options.targetsExistingRecord ?? true,
    action,
    contractNine: options.contractNine ?? false,
    landed: waitingOn === '',
    waitingOn,
  };
}

const TASK_COLLECTION = 'task';
const SETTINGS_COLLECTION = 'settings';
const SESSION_COLLECTION = 'session';

/**
 * A read. It takes the `read` action on the collection it names, targets no
 * revision, and is always landed: the records it reads are the ones the
 * commands above already write.
 */
function read(name: CommandName, collection: string, action: Action = 'read'): CommandDeclaration {
  return {
    name,
    kind: 'read',
    collection,
    targetsExistingRecord: false,
    action,
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
  declare('task.comment', 'comment', { contractNine: true }),
  declare('task.propose', 'write', { contractNine: true }),
  declare('task.decide', 'decide', { targetsExistingRecord: false, contractNine: true }),
  declare('task.pickup', 'write', { targetsExistingRecord: false, contractNine: true }),
  declare('task.handback', 'write', { targetsExistingRecord: false, contractNine: true }),

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

  read('task.read', TASK_COLLECTION),
  read('task.board', TASK_COLLECTION),
  // The work a decision approved and nobody has picked up (I12). It is a read
  // because it writes nothing and it is a *projection* rather than a claim:
  // reading the queue reserves nothing, and two workers reading it see the
  // same row until one of them picks it up.
  read('task.queue', TASK_COLLECTION),
  read('person.list', 'person'),
  // `preset` is what this route is about; the grant it takes is `manage` on
  // the family the request names, which `reads/dispatch.ts` reads off the
  // request and `planPresetSync` checks again from its own mapping.
  read('preset.plan', 'preset', 'manage'),
  // `read` on `settings`, not `manage`: a setting is a business fact every
  // member works against, and a member who cannot see the four-eyes band
  // cannot tell a refusal from a bug. The writes stay `manage`, which is the
  // whole of the asymmetry.
  read('settings.read', SETTINGS_COLLECTION),
  // Declared with a collection and an action like every other row, and served
  // without asking them: `reads/dispatch.ts` answers this one from membership
  // alone. The declaration still carries the pair because the table is what
  // the route generator and the parity test read, and a row missing half its
  // shape would be a special case in three more places than one.
  read('session.capabilities', SESSION_COLLECTION),

  declare('settings.set_four_eyes_threshold', 'manage', {
    collection: SETTINGS_COLLECTION,
    targetsExistingRecord: false,
  }),
  declare('settings.set_client_sign_off', 'manage', {
    collection: SETTINGS_COLLECTION,
    targetsExistingRecord: false,
  }),
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
 * everything it touched (minimum contract 4.3). The reads write nothing, so
 * there is no revision for any of them to be writing against — including
 * `settings.read`, where the absence is a schema gap rather than a decision:
 * `business_settings` carries no revision column at all.
 */
export const NEEDS_NO_EXPECTED_REVISION: ReadonlySet<CommandName> = new Set([
  'person.list',
  'preset.plan',
  'session.capabilities',
  'settings.read',
  'settings.set_client_sign_off',
  'settings.set_four_eyes_threshold',
  'task.board',
  'task.create',
  'task.decide',
  'task.handback',
  'task.pickup',
  'task.purge',
  'task.queue',
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
