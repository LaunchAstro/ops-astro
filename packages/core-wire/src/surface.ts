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
// the nine, and `CONTRACT_NINE` (re-exported below) names the nine so the two sets stay
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
import type { CommandName } from './command-names.ts';
import type { CommandDeclaration } from './surface-declaration.ts';
import { WAYFINDER_MAP_LOCK } from './surface-wayfinder.ts';
import { WRITE_OPERANDS } from './write-operands.ts';

export type { CommandName } from './command-names.ts';

export type { CommandDeclaration } from './surface-declaration.ts';

export type { Operand, OperandKind, OperandSpec } from './write-operands.ts';

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
    readonly authority?: readonly string[];
    readonly rule?: string;
    readonly audited?: boolean;
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
    ...(options.authority === undefined ? {} : { authority: options.authority }),
    ...(options.rule === undefined ? {} : { rule: options.rule }),
    name,
    kind: 'write',
    collection: options.collection ?? TASK_COLLECTION,
    targetsExistingRecord,
    authorisedOn: options.authorisedOn ?? (targetsExistingRecord ? 'record' : 'business'),
    targetLock: options.targetLock ?? 'command',
    action,
    agent: options.agent ?? 'never',
    audited: options.audited ?? true,
  };
}

const TASK_COLLECTION = 'task';
const ACCESS_COLLECTION = 'access';
const SETTINGS_COLLECTION = 'settings';
const SESSION_COLLECTION = 'session';
const BILLING_COLLECTION = 'billing';
const CUSTODY_COLLECTION = 'custody';
const MANDATE_COLLECTION = 'mandate';
const CONVERSATION_COLLECTION = 'conversation';
const TIME_COLLECTION = 'time';
const TAG_COLLECTION = 'tag';
const SPEND_COLLECTION = 'spend';
const ACCOUNT_COLLECTION = 'account';
const PREFERENCE_COLLECTION = 'preference';
const INBOX_COLLECTION = 'inbox';
const RECORD_WRITE = { collection: 'record', targetsExistingRecord: false } as const;

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
    readonly authorisedOn?: 'record' | 'business' | 'self';
    readonly authority?: readonly string[];
    readonly audited?: boolean;
  } = {},
): CommandDeclaration {
  return {
    ...(options.authority === undefined ? {} : { authority: options.authority }),
    name,
    kind: 'read',
    collection,
    targetsExistingRecord: false,
    authorisedOn: options.authorisedOn ?? 'business',
    targetLock: 'command',
    action: options.action ?? 'read',
    agent: options.agent ?? 'never',
    // Every read writes its event (`reads/dispatch.ts`, I13), but a person's
    // own preferences (CS-2.8).
    audited: options.audited ?? true,
  };
}

export const COMMAND_SURFACE: readonly CommandDeclaration[] = [
  // An agent credential's under its person's business-wide `task:write`
  // (API-2); under a pickup's one-task delegation it is outside the purpose.
  declare('task.create', 'write', {
    targetsExistingRecord: false,
    untargetedIdentifiers: ['parentId', 'board', 'boardSection', 'conversationId'],
    agent: 'delegated',
  }),
  // An agent writes the description, its brief, the name, the due date and
  // the page link on its own task inside its delegation (MP-4-7, MP-4-8,
  // MP-4-12), and no other field: `updateTaskAsAgent` refuses the rest.
  declare('task.update', 'write', { agent: 'delegated' }),
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
  // AW-04: the plan accept is `task.decide`'s approval asked on the gate's own
  // task, with the plan bound and the run's instruction file pinned in the
  // same transaction. Out of the agent's reach: only a person activates.
  declare('task.accept_plan', 'decide', {
    targetsExistingRecord: false,
    authorisedOn: 'target',
    untargetedIdentifiers: ['gateId', 'versionId', 'conversationId'],
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
  // Any state of the business's own workflow but a completed one, by its
  // record id (the status select: Waiting on client, On hold). A person's
  // call: an agent's lifecycle stays pickup and handback.
  declare('task.set_state', 'write'),
  // Duplicate without contents (MP-4-8, CS-4.12): a new task for the chosen
  // client from the shell sent. `task:write` is asked there (`target`: party
  // scope, the business for none); the handler asks it again with `read` on the
  // old task in `recordId`, and `share` at the chosen client when it differs from the old
  // task's (ORCH57B11), all on current grants. A person's only, whatever a delegation holds.
  declare('task.duplicate', 'write', {
    targetsExistingRecord: false,
    authorisedOn: 'target',
    untargetedIdentifiers: ['recordId'],
    authority: ['task:read', 'task:write'],
    rule: 'carried text naming the old client: refused CARRIED_TEXT_NAMES_CLIENT (409) until confirmed',
  }),
  // An agent sets the assignee of its own task when its delegation holds
  // `task:assign` (MP-4-8), and not the delegate: `assignTaskAsAgent`.
  declare('task.assign', 'assign', { agent: 'delegated' }),
  declare('task.triage', 'write'),
  declare('task.set_stage', 'write'),
  declare('task.set_party', 'share', {
    rule: 'once the task has content: refused CLIENT_LOCKED (409), writes nothing, on every path (S0-5)',
  }),
  declare('task.set_audience', 'share'),
  declare('task.reparent', 'write', { serialise: TASK_PLACEMENT_LOCK }),
  declare('task.move', 'write', { serialise: TASK_PLACEMENT_LOCK }),
  // The three marks the rank reads (MP-4-9). `task:write`, as `task.update`
  // asks, and an agent sets them inside its delegation like a comment.
  declare('task.set_scores', 'write', { agent: 'delegated' }),
  // The Ad hoc mark (MP-4-10, CS-4.9): `task:write`, and an agent sets it on
  // its own task inside its delegation.
  declare('task.set_adhoc', 'write', { agent: 'delegated' }),
  // The task's work label (MP-4-8, CS-4.16): `task:write`, and an agent sets
  // it on its own task inside its delegation. A label only (R76): it reaches
  // no grant, delegation or scope.
  declare('task.set_category', 'write', { agent: 'delegated' }),
  // Client access (MP-4-10, CS-4.10, R45): the task's share grants to its
  // client's people, created and withdrawn under `access:share`, which an
  // agent never holds (contract 2.3 to 2.6). The target row is the lock, so
  // two at once on one task leave one share per person.
  declare('task.share_with_client', 'share', { collection: ACCESS_COLLECTION }),
  declare('task.revoke_client_share', 'share', { collection: ACCESS_COLLECTION }),
  // An author's own message or reply, rewritten or deleted (MP-4-5,
  // CS-4.34): `task:comment` on the task, as the comment itself, and an
  // agent inside its delegation on its own words only (the handler's check).
  declare('task.edit_comment', 'comment', { agent: 'delegated' }),
  declare('task.delete_comment', 'comment', { agent: 'delegated' }),

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
  // `decide` on tasks (`gate:decide`), asked per row inside the query, so a
  // record-scoped decider sees its own records' gates (`reads/awaiting-review.ts`).
  read('gate.pending', TASK_COLLECTION, { action: 'decide' }),
  // `read` on tasks, asked per run inside the query, so a record-scoped reader
  // sees its own tasks' runs (`reads/attribution.ts`). No agent route.
  read('definition.attribution', TASK_COLLECTION),
  // The activity ledger. `read` on tasks across the business, because it
  // lists every task's writes; an agent works one delegated task and has no
  // use for the whole business's trail, so it is not offered one.
  read('task.ledger', TASK_COLLECTION),
  read('person.list', 'person'),
  // Served without the business-scope check: a record-scoped reader searches
  // the records they hold, which `reads/search.ts` asks the grant model for,
  // so it names no key of its own (`authority: []`).
  read('task.search', TASK_COLLECTION, { authority: [] }),
  // The Team panel's people strip (MP-7-10): staff only, answered to anyone
  // else as for a thing they cannot see.
  read('team.list', 'person'),
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
  // It asks no grant of its own (`authority: []`), so discovery lists it for any holder.
  read('session.capabilities', SESSION_COLLECTION, { agent: 'delegated', authority: [] }),
  // The caller's own name, served without a grant (`reads/dispatch.ts`). Never
  // an agent's: the person menu is a person's.
  read('session.person', SESSION_COLLECTION, { authorisedOn: 'self' }),
  // `manage` on `access`, the key the Access screen's grants are changed under
  // (C32): the answer is every person's authority, so reading it is not a
  // member's everyday read. An agent never holds it.
  read('access.read', 'access', { action: 'manage' }),
  // C32: the clients the caller's live grants reach, filtered inside the
  // query, never an agent's. Like `session.capabilities` it asks no one
  // collection (`reads/catalogue.ts`, `holds-any-grant`), so it carries that
  // read's pair for the route generator and the surface inventory, and like it
  // asks no grant at the door (`authority: []`).
  read('client.list', SESSION_COLLECTION, { authority: [] }),
  // C55: `operations:read` (install default owner and administrators), never
  // an agent's.
  read('operations.read', 'operations'),
  // C81's breach drill: `privacy:manage`, the incident's own key, never an
  // agent's. It drafts notices and sends nothing, so it is a read.
  read('privacy.draft_breach_notices', 'privacy', { action: 'manage' }),

  // AW-03. `conversation:write` is the owner's key for their own conversation;
  // the handler refuses a message into anyone else's. The read names its own
  // rule (`reads/conversation.ts`): the owner, or a holder of the read-any
  // grant `conversation:read`, which nobody holds on install. No agent entry:
  // the agent's side of an exchange is written by the product's exchange,
  // never by an agent calling in.
  declare('conversation.start', 'write', {
    collection: CONVERSATION_COLLECTION,
    targetsExistingRecord: false,
    untargetedIdentifiers: [],
  }),
  declare('conversation.message', 'write', {
    collection: CONVERSATION_COLLECTION,
    targetsExistingRecord: false,
    untargetedIdentifiers: ['conversationId'],
  }),
  read('conversation.read', CONVERSATION_COLLECTION),
  // MP-7-11's tab row, under the same rule: the owner's own, no agent entry.
  // The list is the caller's own conversations and nobody else's, whatever
  // read-any grant they hold; its rule is the read's own, like the read's.
  // The grant that rule asks is `conversation:write`, the owner's key, so the
  // catalogue names that one (API-1), not the declared pair.
  read('conversation.list', CONVERSATION_COLLECTION, { authority: ['conversation:write'] }),
  // AW-04 (U10): the drawer's allowance line, under the list's rule and the
  // team's only, since the cap and what is left are the business's; the spend
  // is the caller's own conversation's (`reads/allowance.ts`). No agent entry.
  // Its rule asks `conversation:write`, as the list's does, so the catalogue
  // names that one (API-1).
  read('conversation.allowance', CONVERSATION_COLLECTION, { authority: ['conversation:write'] }),
  declare('conversation.rename', 'write', {
    collection: CONVERSATION_COLLECTION,
    targetsExistingRecord: false,
    untargetedIdentifiers: ['conversationId'],
  }),
  declare('conversation.set_scope', 'write', {
    collection: CONVERSATION_COLLECTION,
    targetsExistingRecord: false,
    untargetedIdentifiers: ['conversationId'],
  }),

  // Neither settings command names a record. The setting is chosen by the
  // command, so a body carrying a `recordId` is a body the caller believes was
  // honoured and it is refused rather than dropped. The four-eyes threshold is
  // a money action (MP-2-11, owner line 71): `spend:decide`, so C59's step-up
  // judges it, and `settings:manage` alone does not reach it.
  declare('settings.set_four_eyes_threshold', 'decide', {
    collection: SPEND_COLLECTION,
    targetsExistingRecord: false,
    untargetedIdentifiers: [],
  }),
  declare('settings.set_client_sign_off', 'manage', {
    collection: SETTINGS_COLLECTION,
    targetsExistingRecord: false,
    untargetedIdentifiers: [],
  }),
  // C59's money step-up and MP-2-11's two windows: switched only by
  // `settings:manage` (the owner or an administrator), never by an agent, and
  // audited by the envelope.
  ...(
    [
      'settings.set_money_step_up',
      'settings.set_conversation_window',
      'settings.set_retention_window',
    ] as const
  ).map((name) =>
    declare(name, 'manage', {
      collection: SETTINGS_COLLECTION,
      targetsExistingRecord: false,
      untargetedIdentifiers: [],
    }),
  ),
  // C55: a privacy incident is recorded under `privacy:manage` (the owner and
  // administrators), never by an agent, and audited by the envelope as a
  // digest of the act.
  declare('privacy.record_incident', 'manage', {
    collection: 'privacy',
    targetsExistingRecord: false,
    untargetedIdentifiers: [],
  }),
  // C81: each step of a legal document's version is `privacy:manage` (the
  // owner and administrators), never an agent's. Approval and publication
  // name the version; a foreign or made-up one is NOT_FOUND.
  declare('legal.draft_version', 'manage', {
    collection: 'privacy',
    targetsExistingRecord: false,
    untargetedIdentifiers: [],
  }),
  declare('legal.approve_version', 'manage', {
    collection: 'privacy',
    targetsExistingRecord: false,
    untargetedIdentifiers: ['versionId'],
  }),
  declare('legal.publish_version', 'manage', {
    collection: 'privacy',
    targetsExistingRecord: false,
    untargetedIdentifiers: ['versionId'],
  }),
  // C81: a row of the overseas-services register is set under
  // `privacy:manage`, never by an agent; every change is audited by the
  // envelope.
  declare('privacy.set_overseas_service', 'manage', {
    collection: 'privacy',
    targetsExistingRecord: false,
    untargetedIdentifiers: [],
  }),
  // C81: a class of the data-class register is set under `privacy:manage`,
  // never by an agent; every change is audited by the envelope.
  declare('privacy.set_data_class', 'manage', {
    collection: 'privacy',
    targetsExistingRecord: false,
    untargetedIdentifiers: [],
  }),
  // S0-5: the first-client gate moves only under `operations:manage` in the
  // business that operates the installation (`gate-write.ts`), never by an
  // agent; each act is audited by the envelope.
  declare('operations.record_gate_item', 'manage', {
    collection: 'operations',
    targetsExistingRecord: false,
    untargetedIdentifiers: [],
  }),
  declare('operations.change_installation_mode', 'manage', {
    collection: 'operations',
    targetsExistingRecord: false,
    untargetedIdentifiers: [],
  }),

  // API-2: an agent credential is a person's own, so both are `credential:write`
  // and never an agent's. A revocation of another person's credential asks
  // `access:manage` too, under the row's lock (`credential-write.ts`).
  declare('credential.issue', 'write', {
    collection: 'credential',
    targetsExistingRecord: false,
    untargetedIdentifiers: [],
  }),
  declare('credential.revoke', 'write', {
    collection: 'credential',
    targetsExistingRecord: false,
    untargetedIdentifiers: ['credentialId'],
  }),

  // C32: the client record, the tracked action `record created (client)`
  // under `record:write`, never an agent's. C41's one record-create command
  // takes it over (RC-13).
  declare('client.create', 'write', {
    collection: 'record',
    targetsExistingRecord: false,
    untargetedIdentifiers: [],
  }),
  // C41-A (RC-13): `record:write` business-wide; the start and a step result ask `task:write` too.
  declare('record.create', 'write', { ...RECORD_WRITE, untargetedIdentifiers: [] }),
  declare('onboarding.start', 'write', { ...RECORD_WRITE, untargetedIdentifiers: ['clientId'] }),
  declare('onboarding.step_result', 'write', {
    targetsExistingRecord: false,
    authorisedOn: 'target',
    untargetedIdentifiers: ['recordId'],
    agent: 'delegated',
  }),
  // C32: the tracked action `grant changed` on Settings ▸ Access, under
  // `access:manage` (the owner and administrators), never an agent's. A grant
  // names a person of the business and a client of it, or the whole business;
  // a revocation names any grant of the business.
  declare('access.grant', 'manage', {
    collection: 'access',
    targetsExistingRecord: false,
    untargetedIdentifiers: ['holderId', 'clientId'],
  }),
  declare('access.revoke', 'manage', {
    collection: 'access',
    targetsExistingRecord: false,
    untargetedIdentifiers: ['grantId'],
  }),
  // C58: the tracked action `access ended (person: login, sessions, grants)`
  // on Settings ▸ Access, under `access:manage`, never an agent's. It names a
  // person of the business; the provider steps it owes run after it commits.
  declare('access.end', 'manage', {
    collection: 'access',
    targetsExistingRecord: false,
    untargetedIdentifiers: ['holderId'],
  }),
  // C59 (ORCH65-Q3): the tracked action `second factor reset (person, by)`
  // under `settings:manage`, never an agent's. It names a member of the
  // business; the provider's removal of the factor runs after it commits.
  declare('access.reset_factor', 'manage', {
    collection: SETTINGS_COLLECTION,
    targetsExistingRecord: false,
    untargetedIdentifiers: ['holderId'],
  }),
  // C60: the tracked action `client privacy setting changed (model egress,
  // providers, health, no agent edits)`, under `privacy:manage` on the named
  // client (party scope), never an agent's.
  declare('client.set_privacy', 'manage', {
    collection: 'privacy',
    targetsExistingRecord: false,
    authorisedOn: 'target',
    untargetedIdentifiers: ['clientId'],
  }),

  // Custody (C31). `custody:manage` for all three, never an agent (the key
  // catalogue: owner and administrators). The list is asked per row by the
  // scopes the caller holds the key at, so a client-scoped holder sees that
  // client's secrets only; setting and clearing are business-wide.
  read('secret.list', CUSTODY_COLLECTION, { action: 'manage' }),
  declare('secret.set', 'manage', {
    collection: CUSTODY_COLLECTION,
    targetsExistingRecord: false,
    untargetedIdentifiers: ['clientId'],
  }),
  declare('secret.clear', 'manage', {
    collection: CUSTODY_COLLECTION,
    targetsExistingRecord: false,
    untargetedIdentifiers: ['secretId'],
  }),

  // The connector fleet (MP-14-7a): `connection:read`, asked per row of the caller's scopes. A
  // repair touches the credential's custody, so `custody:manage` business-wide, never an agent.
  read('connection.fleet', 'connection'),
  read('connection.signal', 'connection'),
  // The per-client graduation region (MP-14-10a): the same page's key, asked per client by the
  // scopes the caller holds it at, never an agent.
  read('connection.graduation', 'connection'),
  declare('connector.repair', 'manage', {
    collection: CUSTODY_COLLECTION,
    targetsExistingRecord: false,
    untargetedIdentifiers: ['connectionId'],
  }),
  // Standing mandates (MP-14-10a): every change is `mandate:manage` business-wide (owner and
  // administrators; a mandate carries a spend ceiling, so C59's step-up applies), never an agent.
  declare('mandate.file', 'manage', {
    collection: MANDATE_COLLECTION,
    targetsExistingRecord: false,
    untargetedIdentifiers: ['clientId'],
  }),
  declare('mandate.revoke', 'manage', {
    collection: MANDATE_COLLECTION,
    targetsExistingRecord: false,
    untargetedIdentifiers: ['mandateId'],
  }),
  declare('graduation.promote', 'manage', {
    collection: MANDATE_COLLECTION,
    targetsExistingRecord: false,
    untargetedIdentifiers: ['classId'],
  }),
  declare('graduation.demote', 'manage', {
    collection: MANDATE_COLLECTION,
    targetsExistingRecord: false,
    untargetedIdentifiers: ['classId'],
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
  // effect-time facts under its own locks.
  declare('task.dispatch', 'write', {
    targetsExistingRecord: false,
    authorisedOn: 'claim',
    untargetedIdentifiers: ['leaseId'],
    runtimeShaped: 'leaseId',
    agent: 'delegated',
  }),
  // Asked of the lease like heartbeat: the lease holder records the check,
  // and the row names the holder as the actor that performed it.
  declare('task.check', 'write', {
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
  // Wayfinder (WF-1). No agent reaches these until API-2's narrowed credential
  // lands: the retype rule's floor.
  declare('task.set_type', 'write'),
  declare('map.revise', 'write', { serialise: WAYFINDER_MAP_LOCK }),
  // A client change, as `task.set_party`: `share`, and locked once the map has content.
  declare('map.scope', 'share', {
    serialise: WAYFINDER_MAP_LOCK,
    rule: 'once the map has content: refused CLIENT_LOCKED (409), writes nothing, as task.set_party (S0-5)',
  }),
  read('map.view', TASK_COLLECTION, { authorisedOn: 'record' }),
  read('map.frontier', TASK_COLLECTION, { authorisedOn: 'record' }),
  // `billing:decide` on the whole business (AW-04, U10): owners and
  // administrators set the planning cap; no agent route serves it.
  declare('budget.set_planning_cap', 'decide', {
    collection: BILLING_COLLECTION,
    targetsExistingRecord: false,
    untargetedIdentifiers: [],
  }),
  // The lease holder's, asked of the lease's task like the heartbeat. The
  // agent path checks the delegation; the broker then verifies the lease, the
  // delegation and the reservation again under their locks when it holds the
  // money. A person holding a lease has no route to it (AW-01, "n/a (system)").
  declare('model.call', 'write', {
    targetsExistingRecord: false,
    authorisedOn: 'claim',
    untargetedIdentifiers: ['leaseId'],
    runtimeShaped: 'leaseId',
    agent: 'delegated',
  }),
  // The answers at the budget stop: `decide` on `billing` for a top-up and on
  // `gate` for the end, each asked of the task the body names, like the work
  // controls. The runtime asks the same pair of the run's own task again under
  // its locks, and the handler refuses a run on another task. Neither writes
  // the task record. No agent reaches either: an agent never holds decide.
  declare('run.top_up', 'decide', {
    collection: 'billing',
    targetsExistingRecord: false,
    authorisedOn: 'record',
    untargetedIdentifiers: ['recordId', 'runId'],
  }),
  declare('run.end_at_budget_stop', 'decide', {
    collection: 'gate',
    targetsExistingRecord: false,
    authorisedOn: 'record',
    untargetedIdentifiers: ['recordId', 'runId'],
  }),
  // `write` on `run`, asked of the task the body names (ORCH33); the handler
  // refuses a run on another task. It has a version of its own, not the
  // task's revision. An agent reaches it only where its delegation was minted
  // with `run` (ORCH34), and the mint holds `run` to `write`.
  declare('run.revise_state', 'write', {
    collection: 'run',
    targetsExistingRecord: false,
    authorisedOn: 'record',
    untargetedIdentifiers: ['recordId', 'runId'],
    agent: 'delegated',
  }),
  // AW-11: `run:write` inside the parent's delegation, asked of its lease's
  // task like the heartbeat; the runtime binds the parent to that lease at its
  // fence under the locks. A person holding a lease has no route to it.
  declare('run.delegate_child', 'write', {
    collection: 'run',
    targetsExistingRecord: false,
    authorisedOn: 'claim',
    untargetedIdentifiers: ['leaseId'],
    runtimeShaped: 'leaseId',
    agent: 'delegated',
  }),
  // The helper's handback answers to its own child credential, bound to its
  // own login by the runtime, not to a grant: a revoked or run-out child still
  // hands its partial work back, and the handback grants nothing.
  declare('run.child_handback', 'write', {
    collection: 'run',
    targetsExistingRecord: false,
    untargetedIdentifiers: [],
    agent: 'delegated',
  }),
  // Sign-out: the caller's own account, never anyone else's and never an
  // agent's. It targets no record and takes no identifier, so a body naming a
  // person, an actor or an account is refused rather than ignored.
  declare('session.end', 'write', {
    collection: ACCOUNT_COLLECTION,
    targetsExistingRecord: false,
    authorisedOn: 'self',
    untargetedIdentifiers: [],
  }),

  // A person's own preferences (MP-2-11a): the caller's row only, no grant
  // asked. No agent reaches either row yet.
  read('preference.read', PREFERENCE_COLLECTION, { authorisedOn: 'self', audited: false }),
  declare('preference.save', 'write', {
    collection: PREFERENCE_COLLECTION,
    targetsExistingRecord: false,
    authorisedOn: 'self',
    untargetedIdentifiers: [],
    audited: false,
  }),
  // One guided tip dismissed (MP-2-11, CS-9.1), merged into the caller's own
  // `tips.dismissed`; the reset is `preference.save` of that key as `{}`.
  declare('preference.dismiss_tip', 'write', {
    collection: PREFERENCE_COLLECTION,
    targetsExistingRecord: false,
    authorisedOn: 'self',
    untargetedIdentifiers: [],
    audited: false,
  }),

  // Time tracking (MP-4-6, CS-4.1, CS-4.28 to CS-4.30): `write` on `time`,
  // asked of the business, and the handler then asks `task:read` on the task
  // the entry is against, so a person times only a task they may read. Each
  // reaches only the caller's own entries. The key catalogue lets an agent
  // hold `time:write` inside its delegation; the agent path does not serve
  // these yet, so it is `never` here until it does.
  ...(['time.start', 'time.stop', 'time.log'] as const).map((name) =>
    declare(name, 'write', {
      collection: TIME_COLLECTION,
      targetsExistingRecord: false,
      untargetedIdentifiers: ['taskId'],
    }),
  ),
  ...(['time.set_note', 'time.delete'] as const).map((name) =>
    declare(name, 'write', {
      collection: TIME_COLLECTION,
      targetsExistingRecord: false,
      untargetedIdentifiers: ['entryId'],
    }),
  ),

  // Tags (MP-4-11, CS-4.19 to CS-4.21). A new tag is `tag:write` on the
  // business; adding and removing are `task:write` on the task named in
  // `recordId`; the vocabulary is `task:read` on the business, so a reader
  // held to one client's records is not shown the business's tags. The key
  // catalogue lets an agent hold these inside its delegation; the agent path
  // does not serve them yet, so they are `never` here until it does, as the
  // time commands are.
  declare('tag.create', 'write', {
    collection: TAG_COLLECTION,
    targetsExistingRecord: false,
    untargetedIdentifiers: [],
  }),
  ...(['task.add_tag', 'task.remove_tag'] as const).map((name) =>
    declare(name, 'write', {
      targetsExistingRecord: false,
      authorisedOn: 'record',
      untargetedIdentifiers: ['recordId', 'tagId'],
    }),
  ),
  read('tag.list', TASK_COLLECTION),
  read('task.todos', TASK_COLLECTION),

  // The inbox is one person's: no agent reaches it, and each row answers the
  // caller about their own items only, with access derived per item.
  read('inbox.read', INBOX_COLLECTION, { authorisedOn: 'self' }),
  read('inbox.count', INBOX_COLLECTION, { authorisedOn: 'self' }),
  declare('inbox.seen', 'write', {
    collection: 'preference',
    targetsExistingRecord: false,
    authorisedOn: 'self',
    untargetedIdentifiers: ['itemId'],
  }),
  // `operations:read`: owner and administrators by default, never an agent
  // (the catalogue's C55 row). It names other people's items, so it is not
  // `self`.
  read('inbox.unattended', 'operations'),
  // AW-13 readers: a task's runs' trace, `operations:read` asked at the task's
  // record scope and, inside it, the task's own read. Never an agent: no
  // agent-reachable operation returns a trace (the ticket's `no agent read`).
  read('trace.read', 'operations', { authorisedOn: 'record' }),
  // AW-12: the harness test's result on one run, computed from its frozen
  // manifest. `read` on tasks, asked inside the statement on the run's task
  // (`reads/harness-trigger.ts`). Never an agent: the owner reads it, and no
  // framework under test reaches its own verdict.
  read('harness.read', TASK_COLLECTION),
  // Per channel, never per item: the body names no item. Self-scoped like
  // `inbox.seen`, so it asks no grant and reaches the caller's own setting.
  declare('notifications.set_channel', 'write', {
    collection: 'preference',
    targetsExistingRecord: false,
    authorisedOn: 'self',
    untargetedIdentifiers: [],
  }),

  // Team conversations (C71-D): `chat:comment`, agency members only, never an agent or a client.
  declare('chat.send_direct', 'comment', {
    collection: 'chat',
    targetsExistingRecord: false,
    untargetedIdentifiers: ['teammateId'],
  }),
  read('chat.conversations', 'chat', { action: 'comment' }),
  read('chat.messages', 'chat', { action: 'comment' }),
  // The reader's own read marker (CS-7.25): their member row, no grant asked, not audited.
  declare('chat.mark_read', 'write', {
    collection: ACCOUNT_COLLECTION,
    targetsExistingRecord: false,
    authorisedOn: 'self',
    untargetedIdentifiers: ['conversationId'],
    audited: false,
  }),

  // C39-T: `access:share` on the whole business, a person's key no agent holds
  // (the permission key catalogue). Another business's invitation is
  // NOT_FOUND from the handler, as an id nobody issued. An administrator's
  // invitation, created or resent, also asks `access:manage` in the handler.
  ...(['invitation.create', 'invitation.resend', 'invitation.revoke'] as const).map((name) =>
    declare(name, 'share', {
      collection: 'access',
      targetsExistingRecord: false,
      untargetedIdentifiers: name === 'invitation.create' ? [] : ['invitationId'],
    }),
  ),
  // Settings ▸ Workflow triggers (C33). The registry is a business fact read
  // like `settings.read`; an activation is changed under `settings:manage` and
  // a version released under `automation:manage`, both business-wide and
  // never an agent's (the key catalogue: owner and administrators).
  read('automation.registry', SETTINGS_COLLECTION),
  declare('activation.change', 'manage', {
    collection: SETTINGS_COLLECTION,
    targetsExistingRecord: false,
    untargetedIdentifiers: ['activationId', 'versionId'],
  }),
  declare('definition.release', 'manage', {
    collection: 'automation',
    targetsExistingRecord: false,
    untargetedIdentifiers: ['definitionId'],
  }),
  // Standing approvals (C52-A): adopting a version, rolling back, turning off
  // and revoking are `automation:manage`, business-wide, never an agent's.
  declare('activation.adopt', 'manage', {
    collection: 'automation',
    targetsExistingRecord: false,
    untargetedIdentifiers: ['activationId', 'versionId'],
  }),
  declare('activation.roll_back', 'manage', {
    collection: 'automation',
    targetsExistingRecord: false,
    untargetedIdentifiers: ['activationId'],
  }),
  declare('activation.turn_off', 'manage', {
    collection: 'automation',
    targetsExistingRecord: false,
    untargetedIdentifiers: ['activationId'],
  }),
  declare('approval.revoke', 'manage', {
    collection: 'automation',
    targetsExistingRecord: false,
    untargetedIdentifiers: ['approvalId'],
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

// The contract's nine, in its own file.
export { CONTRACT_NINE } from './surface-contract-nine.ts';

// An attempt's effect identity (T2c2), in its own file.
export { effectAttemptOf, effectOperationId } from './effect-identity.ts';

/** The path the HTTP boundary and the command line both derive from the name. */
export function pathOf(name: CommandName): string {
  return `/${name.replace('.', '/')}`;
}

// Where the surface is served, and the headers it is served with (`paths.ts`).
export {
  ACCOUNT_AVAILABILITY_PATH,
  CSRF_HEADER,
  DELEGATION_HEADER,
  PREFIX,
  PUBLIC_PREFIX,
  SESSION_COOKIE,
  SESSION_HEADER,
  SESSION_PATH,
} from './paths.ts';

// The writes an external party (R4) may reach, in their own file.
export { EXTERNAL_WRITES, admitsSelfWrite } from './surface-external.ts';

/** The reads, which no caller may reach through the command envelope. */
export const READS: readonly CommandName[] = COMMAND_SURFACE.filter(
  (command) => command.kind === 'read',
).map((command) => command.name);
