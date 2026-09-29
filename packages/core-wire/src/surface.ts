// SPDX-License-Identifier: AGPL-3.0-only
//
// The command surface: every domain operation, declared once.
//
// This table is the thing the surface inventory enumerates
// (`tests/acceptance/surface-inventory.test.ts`) and the thing the Hono adapter
// builds its routes from, so an operation that exists and an operation that is
// reachable cannot come apart: adding a row here adds the endpoint, and a
// command with no row has no route to be reached through.
//
// **Why there are more than nine.** The contract names nine (minimum contract
// 4.3) and this part is titled after them. But the task type T1e installed
// names ten *owning operations* on its own field definitions, and minimum
// contract 5.3's fourth assertion requires each of them to exist and be
// reachable through an endpoint — "a protected field whose owning operation
// does not exist is a field nobody can change". Specification 2.2's second
// observable result asks a person to assign a task and move it through stages,
// which are two of those ten. So the owning operations are declared here with
// the nine, and `CONTRACT_NINE` below names the nine so the two sets stay
// distinguishable rather than merged. The three trash-family operations are here for the same
// reason: specification 14.3 requires the purge to write an audit event, and
// an audit event is written by a command.
//
// **One row per command.** Every fact about a command that more than one module
// reads is on its row: what it is authorised on, whether it takes an expected
// revision, which identifiers an untargeted write may carry, which identifier
// the runtime shapes itself, and whether an agent may reach it. `prepare.ts`,
// the envelope and the agent path read the row rather than a list of names of
// their own, so adding a command is one row. The handlers stay in
// `handlers.ts`, keyed by the same name,
// because the web client imports this table and must not import the database.

import type { Action } from '../../core-records/src/index.ts';

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
  | 'task.set_scores'
  | 'task.set_adhoc'
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
  | 'task.execution'
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
  | 'settings.set_client_sign_off'
  // The support controls the contract ledger requires through owning
  // production interfaces: revocation of an existing grant or delegation,
  // cancellation of a run's lineage, an authorised restart as a new lineage,
  // and the lease owner's heartbeat. None is a new actor power; each asks for
  // authority the caller already holds (see each row below).
  | 'grant.revoke'
  | 'delegation.revoke'
  | 'task.cancel'
  | 'task.restart'
  | 'task.heartbeat'
  // The lease holder marks its step dispatched before any effect (T2c1).
  | 'task.dispatch'
  // The lease holder observes its applied effect, and a person reads the
  // receipt citing the decision it came from (T2c2).
  | 'task.observe'
  | 'task.receipt'
  // A person raises a task's envelope, two people above the band (T2e).
  | 'budget.top_up'
  // A person records what an unknown effect came to: one of three (T3d1).
  | 'budget.record_outcome'
  // A person closes an unknown hold at an amount, with a reason (T3c).
  | 'budget.write_off';

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
   */
  readonly authorisedOn: 'record' | 'business' | 'target' | 'claim';
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
}

/**
 * The JSON kind of one operand: `id` and `text` are strings, `count` a finite
 * number, `flag` a boolean, `map` an object that is not an array, `any`
 * whatever the command checks by value itself. `?` admits absent, `|null`
 * admits null.
 */
export type OperandKind = 'id' | 'text' | 'count' | 'flag' | 'map' | 'any';
export type Operand = `${OperandKind}${'' | '?'}${'' | '|null'}`;
export type OperandSpec = Readonly<Record<string, Operand>>;

/**
 * The key `task.reparent` and `task.move` serialise on. One key for both: a
 * move carries its subtree's board and a reparent reads its parent, so either
 * can wait on a row the other holds.
 */
const TASK_PLACEMENT_LOCK = 'task.placement';

function declare(
  name: CommandName,
  action: Action,
  options: {
    readonly collection?: string;
    readonly targetsExistingRecord?: boolean;
    readonly authorisedOn?: CommandDeclaration['authorisedOn'];
    readonly targetLock?: CommandDeclaration['targetLock'];
    readonly serialise?: string;
    readonly untargetedIdentifiers?: readonly string[];
    readonly runtimeShaped?: string;
    readonly agent?: CommandDeclaration['agent'];
  } = {},
): CommandDeclaration {
  const targetsExistingRecord = options.targetsExistingRecord ?? true;
  return {
    operands: WRITE_OPERANDS[name] ?? {},
    ...(options.untargetedIdentifiers === undefined
      ? {}
      : { untargetedIdentifiers: options.untargetedIdentifiers }),
    ...(options.runtimeShaped === undefined ? {} : { runtimeShaped: options.runtimeShaped }),
    ...(options.serialise === undefined ? {} : { serialise: options.serialise }),
    name,
    kind: 'write',
    collection: options.collection ?? TASK_COLLECTION,
    targetsExistingRecord,
    authorisedOn: options.authorisedOn ?? (targetsExistingRecord ? 'record' : 'business'),
    targetLock: options.targetLock ?? 'command',
    action,
    agent: options.agent ?? 'never',
  };
}

const TASK_COLLECTION = 'task';
const SETTINGS_COLLECTION = 'settings';
const SESSION_COLLECTION = 'session';
const BILLING_COLLECTION = 'billing';

/**
 * A read. It takes the `read` action on the collection it names, targets no
 * revision. It is authorised on the business unless it
 * names one task, which `reads/dispatch.ts` asks about at record scope; the
 * read path decides that from its catalogue row, and
 * `tests/commands/read-authorised-on.test.ts` holds this field to it.
 */
function read(
  name: CommandName,
  collection: string,
  options: {
    readonly action?: Action;
    readonly agent?: CommandDeclaration['agent'];
    readonly authorisedOn?: 'record' | 'business';
  } = {},
): CommandDeclaration {
  return {
    name,
    kind: 'read',
    collection,
    targetsExistingRecord: false,
    authorisedOn: options.authorisedOn ?? 'business',
    targetLock: 'command',
    action: options.action ?? 'read',
    agent: options.agent ?? 'never',
  };
}

// Each write's operands, as `requests.ts` types them. `recordId` is here on
// every targeted command, and `operationId` and `expectedRevision` nowhere:
// the envelope reads those two itself. An operand whose kind its command
// already answers in its own words (a comment's `comment_type`, a pickup's
// reservation, a revocation's absent id, a reparent's parent after its task)
// is `any` here, so the caller keeps that answer and its place.
const TARGET = { recordId: 'id' } as const;
const FIELDS = { ...TARGET, fields: 'map' } as const;
const WRITE_OPERANDS: Readonly<Partial<Record<CommandName, OperandSpec>>> = {
  'task.create': {
    fields: 'map',
    parentId: 'id?|null',
    board: 'id?|null',
    boardSection: 'id?|null',
    stateKey: 'any',
  },
  'task.update': FIELDS,
  'task.complete': TARGET,
  'task.reopen': { ...TARGET, reason: 'any' },
  'task.start': TARGET,
  'task.comment': { ...TARGET, body: 'any', audience: 'any', commentType: 'any' },
  'task.propose': {
    ...TARGET,
    purpose: 'any',
    maximumMinor: 'any',
    currency: 'any',
    payload: 'map',
    step: 'any',
    expiresInSeconds: 'any',
    lineageId: 'id?|null',
  },
  'task.decide': {
    gateId: 'id',
    versionId: 'id',
    decision: 'any',
    note: 'any',
    recipientPersonId: 'id?|null',
  },
  'task.pickup': { reservationId: 'any', leaseSeconds: 'any' },
  // A lease call names its task through its lease; a `recordId` beside the
  // lease is taken and plays no part in the check (API.md, id operands).
  'task.handback': {
    leaseId: 'any',
    recordId: 'any',
    fence: 'any',
    outcome: 'any',
    report: 'any',
    actualMinor: 'any',
    successor: 'any',
  },
  'task.assign': FIELDS,
  'task.triage': FIELDS,
  'task.set_stage': FIELDS,
  'task.set_party': FIELDS,
  'task.set_audience': FIELDS,
  'task.set_scores': FIELDS,
  'task.set_adhoc': FIELDS,
  'task.reparent': { ...TARGET, parentId: 'any' },
  'task.move': { ...TARGET, board: 'any', boardSection: 'any' },
  'task.rank': { ...TARGET, afterId: 'id?|null', beforeId: 'id?|null' },
  'task.trash': TARGET,
  'task.restore': { batchId: 'id' },
  'task.purge': { olderThanDays: 'any' },
  'settings.set_four_eyes_threshold': { value: 'any', expectedRevision: 'any' },
  'settings.set_client_sign_off': { value: 'any', expectedRevision: 'any' },
  'grant.revoke': { grantId: 'any' },
  'delegation.revoke': { delegationId: 'any' },
  'task.cancel': { recordId: 'any', lineageId: 'any', reason: 'any' },
  'task.restart': { recordId: 'any', lineageId: 'any', expiresInSeconds: 'any' },
  'task.heartbeat': {
    leaseId: 'any',
    recordId: 'any',
    fence: 'any',
    leaseSeconds: 'any',
    providerStarting: 'any',
  },
  'task.dispatch': { leaseId: 'any', recordId: 'any', fence: 'any' },
  // Minor units, of the maximum the person saw; no standing ceiling (Q168).
  'budget.top_up': { recordId: 'any', amountMinor: 'count', fromMaximumMinor: 'count' },
  // The task, the attempt held unknown, and one of the three outcomes (O7).
  'budget.record_outcome': { recordId: 'any', attemptId: 'any', outcome: 'any' },
  // The task, the attempt held unknown, the minor units charged and why (T3c).
  'budget.write_off': { recordId: 'any', attemptId: 'any', amountMinor: 'count', reason: 'text' },
  'task.observe': {
    leaseId: 'any',
    recordId: 'any',
    fence: 'any',
    attemptId: 'any',
    usage: 'any',
    outcome: 'any',
  },
};

export const COMMAND_SURFACE: readonly CommandDeclaration[] = [
  declare('task.create', 'write', {
    targetsExistingRecord: false,
    untargetedIdentifiers: ['parentId', 'board', 'boardSection'],
  }),
  declare('task.update', 'write'),
  declare('task.complete', 'write'),
  declare('task.reopen', 'write'),
  declare('task.comment', 'comment', { agent: 'delegated' }),
  // The runtime takes cap, envelope, then task; an envelope lock on the
  // task first is the other half of a cycle with handback.
  declare('task.propose', 'write', { targetLock: 'runtime', agent: 'delegated' }),
  // In the agent's reach so a delegated agent is refused by the decision
  // itself, not by the surface: a person decides (case (j) of the matrix).
  // Asked on the gate's own task (`prepare.ts`, `TARGET_LOOKUPS`), so a
  // task-scoped decider decides at the bound; an escalated gate then needs
  // business scope, which the runtime asks under its locks (T3a).
  declare('task.decide', 'decide', {
    targetsExistingRecord: false,
    authorisedOn: 'target',
    untargetedIdentifiers: ['gateId', 'versionId'],
    agent: 'delegated',
  }),
  // Own-lease work is `write` on the task the reservation or lease belongs to,
  // the scope the runtime and `grant.revoke` ask under their locks: a
  // record-scoped writer picks up, renews and hands back on that task.
  declare('task.pickup', 'write', {
    targetsExistingRecord: false,
    authorisedOn: 'claim',
    untargetedIdentifiers: ['reservationId'],
    runtimeShaped: 'reservationId',
    agent: 'before-pickup',
  }),
  declare('task.handback', 'write', {
    targetsExistingRecord: false,
    authorisedOn: 'claim',
    untargetedIdentifiers: ['leaseId'],
    runtimeShaped: 'leaseId',
    agent: 'delegated',
  }),

  declare('task.start', 'write'),
  declare('task.assign', 'assign'),
  declare('task.triage', 'write'),
  declare('task.set_stage', 'write'),
  declare('task.set_party', 'share'),
  declare('task.set_audience', 'share'),
  declare('task.reparent', 'write', { serialise: TASK_PLACEMENT_LOCK }),
  declare('task.move', 'write', { serialise: TASK_PLACEMENT_LOCK }),
  // The three marks the rank reads (MP-4-9). `task:write`, as `task.update`
  // asks, and an agent sets them inside its delegation like a comment.
  declare('task.set_scores', 'write', { agent: 'delegated' }),
  // The Ad hoc mark (MP-4-10, CS-4.9): `task:write`, and an agent sets it on
  // its own task inside its delegation.
  declare('task.set_adhoc', 'write', { agent: 'delegated' }),

  declare('task.rank', 'write'),
  declare('task.trash', 'write'),
  declare('task.restore', 'write', {
    targetsExistingRecord: false,
    untargetedIdentifiers: ['batchId'],
  }),
  declare('task.purge', 'manage', { targetsExistingRecord: false, untargetedIdentifiers: [] }),

  read('task.read', TASK_COLLECTION, { agent: 'delegated', authorisedOn: 'record' }),
  read('task.board', TASK_COLLECTION),
  // The work a decision approved and nobody has picked up (I12). It is a read
  // because it writes nothing and it is a *projection* rather than a claim:
  // reading the queue reserves nothing, and two workers reading it see the
  // same row until one of them picks it up.
  read('task.queue', TASK_COLLECTION, { agent: 'before-pickup' }),
  // One task's runs and their progress events (T2a), after `read` on that task.
  read('task.execution', TASK_COLLECTION, { authorisedOn: 'record' }),
  read('person.list', 'person'),
  // `preset` is what this route is about; the grant it takes is `manage` on
  // the family the request names, which `reads/dispatch.ts` reads off the
  // request and `planPresetSync` checks again from its own mapping.
  read('preset.plan', 'preset', { action: 'manage' }),
  // `read` on `settings`, not `manage`: a setting is a business fact every
  // member works against, and a member who cannot see the four-eyes band
  // cannot tell a refusal from a bug. The writes stay `manage`, which is the
  // whole of the asymmetry.
  read('settings.read', SETTINGS_COLLECTION),
  // Declared with a collection and an action like every other row, and served
  // without asking them: `reads/dispatch.ts` answers this one from membership
  // alone. The declaration still carries the pair because the table is what
  // the route generator and the surface inventory read, and a row missing half its
  // shape would be a special case in three more places than one.
  //
  // An agent reaches it only under a delegation, where it answers the
  // delegation's purpose; before a pickup it is refused like every other
  // operation outside the two (minimum contract 8.2 case 9).
  read('session.capabilities', SESSION_COLLECTION, { agent: 'delegated' }),

  // Neither settings command names a record. The setting is chosen by the
  // command, so a body carrying a `recordId` is a body the caller believes was
  // honoured and it is refused rather than dropped.
  declare('settings.set_four_eyes_threshold', 'manage', {
    collection: SETTINGS_COLLECTION,
    targetsExistingRecord: false,
    untargetedIdentifiers: [],
  }),
  declare('settings.set_client_sign_off', 'manage', {
    collection: SETTINGS_COLLECTION,
    targetsExistingRecord: false,
    untargetedIdentifiers: [],
  }),

  // The grant manager's authority, which is `manage` on the task family this
  // head's grants are about, asked of the revoked row's own scope. The
  // envelope asks nothing business-wide here; `authority-controls.ts` asks the
  // manager's ceiling against the target: `manage` and the same action, held
  // at a scope covering the grant or delegation being revoked.
  declare('grant.revoke', 'manage', {
    targetsExistingRecord: false,
    authorisedOn: 'target',
    untargetedIdentifiers: [],
  }),
  declare('delegation.revoke', 'manage', {
    targetsExistingRecord: false,
    authorisedOn: 'target',
    untargetedIdentifiers: [],
  }),
  // Work control is `decide` on the task (T3a, `gate:decide`): stopping or
  // restarting approved work is a person's decision, never an agent's, and it
  // is asked of that task. Cancel's runtime also asks `write` under its locks.
  // Both name the task in `recordId` and the lineage in `lineageId`, and the
  // handler refuses a lineage opened on another task. They take no
  // `expectedRevision` because neither writes the task record.
  declare('task.cancel', 'decide', {
    targetsExistingRecord: false,
    authorisedOn: 'record',
    untargetedIdentifiers: ['recordId', 'lineageId'],
  }),
  declare('task.restart', 'decide', {
    targetsExistingRecord: false,
    authorisedOn: 'record',
    untargetedIdentifiers: ['recordId', 'lineageId'],
  }),
  // The lease owner's, asked of the lease's task like pickup and handback; the
  // agent path checks the delegation, then the lease.
  declare('task.heartbeat', 'write', {
    targetsExistingRecord: false,
    authorisedOn: 'claim',
    untargetedIdentifiers: ['leaseId'],
    runtimeShaped: 'leaseId',
    agent: 'delegated',
  }),
  // The lease owner's too, asked as heartbeat is; the runtime rechecks the
  // four effect-time facts under its own locks.
  declare('task.dispatch', 'write', {
    targetsExistingRecord: false,
    authorisedOn: 'claim',
    untargetedIdentifiers: ['leaseId'],
    runtimeShaped: 'leaseId',
    agent: 'delegated',
  }),
  // The effect's token is the attempt its dispatch answered; the runtime reads
  // the operation register for the effect under the lease's own locks (T2c2).
  declare('task.observe', 'write', {
    targetsExistingRecord: false,
    authorisedOn: 'claim',
    untargetedIdentifiers: ['leaseId', 'attemptId'],
    runtimeShaped: 'leaseId',
    agent: 'delegated',
  }),
  // What an observed effect came from, asked on the attempt and checked on
  // its task; it names no operation to reverse it (T2c2).
  read('task.receipt', TASK_COLLECTION, { authorisedOn: 'record' }),
  // `billing:decide` on the task (T2e). No agent route serves it, so a
  // delegated agent is refused `DELEGATION_EXCLUDES_OPERATION` everywhere.
  declare('budget.top_up', 'decide', {
    collection: BILLING_COLLECTION,
    targetsExistingRecord: false,
    authorisedOn: 'record',
    untargetedIdentifiers: ['recordId'],
  }),
  // `billing:decide` on the task (T3d1): any person holding it records an
  // unknown effect's outcome (O8); no agent route serves it.
  declare('budget.record_outcome', 'decide', {
    collection: BILLING_COLLECTION,
    targetsExistingRecord: false,
    authorisedOn: 'record',
    untargetedIdentifiers: ['recordId', 'attemptId'],
  }),
  // `billing:decide` on the task (T3c): a person writes an unknown hold off,
  // two above the band; no agent route serves it.
  declare('budget.write_off', 'decide', {
    collection: BILLING_COLLECTION,
    targetsExistingRecord: false,
    authorisedOn: 'record',
    untargetedIdentifiers: ['recordId', 'attemptId'],
  }),
];

const BY_NAME = new Map(COMMAND_SURFACE.map((command) => [command.name, command]));

/**
 * The row a name declares. Total: every `CommandName` has a row, and
 * `command-surface.test.ts` holds the table to the installed model, so no
 * caller guards a miss. A name with no row is this file's
 * own defect, answered here once as the fault it is.
 */
export function declarationOf(name: CommandName): CommandDeclaration {
  const declared = BY_NAME.get(name);
  if (declared === undefined) throw new Error(`surface.ts: ${name} has no declaration row`);
  return declared;
}

/**
 * The commands with no existing record to be stale against: the rows that
 * target none.
 *
 * It is derived from the rows, and
 * `tests/commands/command-catalogue-pin.test.ts` holds the list as a literal,
 * so a new exemption is still a diff to that test. A test comparing a
 * derivation with its own source could not fail.
 *
 * `task.create` has no target yet. `task.restore` and `task.purge` take a
 * batch identity and a window, not a record. `task.decide` binds a proposal
 * version rather than a record revision, `task.pickup` mints a lease without
 * writing the task, and `task.handback` echoes expected versions for
 * everything it touched (minimum contract 4.3). The reads write nothing, so
 * there is no revision for any of them to be writing against. `settings.read`
 * answers with the revision 0020 gave `business_settings`, so a settings write
 * can send it back, but the read itself writes against nothing.
 */
export const NEEDS_NO_EXPECTED_REVISION: ReadonlySet<CommandName> = new Set(
  COMMAND_SURFACE.filter((command) => !command.targetsExistingRecord).map(
    (command) => command.name,
  ),
);

/** The contract's nine, the first nine names of `CommandName`. */
export const CONTRACT_NINE: readonly CommandName[] = [
  'task.create',
  'task.update',
  'task.complete',
  'task.reopen',
  'task.comment',
  'task.propose',
  'task.decide',
  'task.pickup',
  'task.handback',
];

/**
 * The operation identity of an attempt's one effect, derived from the attempt
 * so a retry replays it and "did it happen?" is the register's answer (T2c2).
 * The worker and the server derive it here, from one spelling.
 */
export function effectOperationId(attemptId: string): string {
  return `effect:${attemptId}`;
}

/** The attempt an effect identity names, or `undefined` for any other identity. */
export function effectAttemptOf(operationId: string): string | undefined {
  const found = /^effect:([0-9a-f-]{36})$/u.exec(operationId);
  return found?.[1];
}

/** The path the HTTP boundary and the command line both derive from the name. */
export function pathOf(name: CommandName): string {
  return `/${name.replace('.', '/')}`;
}

/**
 * The two mounts the API serves the surface under and the command line sends
 * to, each followed by the business key and then `pathOf(name)`. One copy for
 * both sides. The agent's is its own so that an
 * agent asking and a person asking cannot be mistaken for each other.
 */
export const PREFIX = { person: '/api/b/', agent: '/api/a/b/' } as const;

/**
 * The header an agent presents its delegation credential in.
 *
 * A header rather than a body field for the same reason the bearer token is
 * one: it is a credential, and a credential in a body is a credential that
 * gets logged with the payload, stored in the register row and compared by a
 * digest. The register compares what the request *is*; the authority it was
 * made under is not part of that.
 */
export const DELEGATION_HEADER = 'x-agent-delegation';

/** The reads, which no caller may reach through the command envelope. */
export const READS: readonly CommandName[] = COMMAND_SURFACE.filter(
  (command) => command.kind === 'read',
).map((command) => command.name);
