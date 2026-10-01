// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: what each command does to data, declared beside its permission key,
// and the class the gate reads, derived from it and never set by hand.

import type { CommandName } from './surface.ts';

/** `client`: a row that holds a task's id or a client's (ADR 0014); `business`: the agency's own. */
export type EffectScope = 'business' | 'client';

/** One record kind a command creates, changes or deletes: its table, and that table's scope. */
export interface RecordWrite {
  readonly kind: string;
  readonly scope: EffectScope;
}

/** Where new content comes from when it is not the app's own. */
export type Intake =
  | 'upload'
  | 'import'
  | 'provider-sync'
  | 'webhook'
  | 'page-capture'
  | 'public-form'
  | 'outside-person-input';

/** A provider write, a link or a stored credential; `forClient` when it is made for a client. */
export interface OutsideEffect {
  readonly provider: string;
  readonly forClient: boolean;
}

export interface DataEffects {
  readonly writes: readonly RecordWrite[];
  readonly intake: readonly Intake[];
  readonly outside: readonly OutsideEffect[];
  /** Admits a new outside person: an invitation or a login for a client person, guest or reviewer. */
  readonly access: boolean;
}

export type DataClass = 'invitation' | 'client-data' | 'made-up-safe';

export interface ClassedEffects extends DataEffects {
  readonly class: DataClass;
}

/**
 * The class, from what the command does: `invitation` if it admits a new
 * outside person; `client-data` if it writes a client-scoped row, takes any
 * intake, or makes an outside effect for a client; `made-up-safe` otherwise.
 */
export function classOf(effects: DataEffects): DataClass {
  if (effects.access) return 'invitation';
  if (
    effects.writes.some((write) => write.scope === 'client') ||
    effects.intake.length > 0 ||
    effects.outside.some((effect) => effect.forClient)
  ) {
    return 'client-data';
  }
  return 'made-up-safe';
}

const business = (...kinds: string[]): RecordWrite[] =>
  kinds.map((kind) => ({ kind, scope: 'business' }));
const client = (...kinds: string[]): RecordWrite[] =>
  kinds.map((kind) => ({ kind, scope: 'client' }));
const writing = (
  writes: readonly RecordWrite[],
  outside: readonly OutsideEffect[] = [],
): DataEffects => ({ writes, intake: [], outside, access: false });

const READ = writing([]);
// A task is a row of `records`, with its unique values beside it.
const TASK = writing(client('records', 'record_unique_values'));
// A proposal raises the decision's inbox items (INB-1b).
const PROPOSAL = writing(
  client(
    'evidence_packs',
    'gates',
    'inbox_items',
    'planned_runs',
    'planned_steps',
    'proposal_lineages',
    'proposal_versions',
    // A proposal raises a decision item for each decide holder (INB-1).
    'inbox_items',
  ),
);
const SETTINGS = writing(business('business_settings'));
const LEGAL = writing(business('legal_document_versions'));
// A grant names a client only by its scope; it holds no content and admits
// no one, and a party-scoped grant needs a client, which is gated itself.
const GRANTS = writing(business('grants'));
const CREDENTIAL = writing(business('agent_credentials', 'actors'));

/**
 * Every command's effects, one entry each: the type is keyed by every command
 * name, so a command added without an entry does not compile. Record kinds
 * are tables. Each is proved against the rows its fixture actually changes
 * (`tests/operations/s0-5-effect-metadata.test.ts`); reads write only the
 * act's audit, which is no record kind.
 */
export const COMMAND_EFFECTS: { readonly [Name in CommandName]: DataEffects } = {
  'task.create': TASK,
  'task.update': TASK,
  'task.complete': TASK,
  'task.reopen': TASK,
  'task.comment': writing(client('records')),
  // A comment's own edit and deletion (MP-4-5), on its record.
  'task.edit_comment': writing(client('records')),
  'task.delete_comment': writing(client('records')),
  'task.propose': PROPOSAL,
  'task.decide': writing(
    client('attempts', 'gate_decisions', 'gates', 'inbox_items', 'reservations', 'task_envelopes'),
  ),
  // An agent's pickup also mints its delegation.
  'task.pickup': writing([
    ...client('attempts', 'leases', 'planned_runs', 'reservations', 'run_events'),
    ...business('delegations'),
  ]),
  'task.handback': writing([
    ...client(
      'alerts',
      'attempts',
      'handback_reports',
      'inbox_items',
      'leases',
      'planned_runs',
      'reservations',
      'run_events',
      'task_envelopes',
    ),
    ...business('delegations'),
  ]),
  'task.start': TASK,
  // An assignment raises the assignee's item (INB-1).
  'task.assign': writing(client('records', 'record_unique_values', 'inbox_items')),
  'task.triage': TASK,
  'task.set_stage': TASK,
  // The status select (Stage 1 adds), the marks (MP-4-9), Ad hoc (MP-4-10) and
  // the category (MP-4-8).
  'task.set_state': TASK,
  'task.set_scores': TASK,
  'task.set_adhoc': TASK,
  'task.set_category': TASK,
  // Client access (MP-4-10): a share grant on the task for its client's people.
  'task.share_with_client': GRANTS,
  'task.revoke_client_share': GRANTS,
  'task.set_party': TASK,
  'task.set_audience': TASK,
  'task.reparent': TASK,
  'task.move': TASK,
  'task.rank': TASK,
  'task.trash': TASK,
  'task.restore': TASK,
  'task.purge': TASK,
  'task.read': READ,
  'task.board': READ,
  'task.queue': READ,
  // The reader's own to-dos (MP-7-1) and the tag vocabulary (MP-4-11).
  'task.todos': READ,
  'tag.list': READ,
  // Time entries (MP-4-6) hold the task's id.
  'time.start': writing(client('time_entries')),
  'time.stop': writing(client('time_entries')),
  'time.log': writing(client('time_entries')),
  'time.set_note': writing(client('time_entries')),
  'time.delete': writing(client('time_entries')),
  // A name in the business's vocabulary, and a task's tags (MP-4-11).
  'tag.create': writing(business('tags')),
  'task.add_tag': writing(client('task_tags')),
  'task.remove_tag': writing(client('task_tags')),
  // Search (C1): finds what the caller may read, and stores nothing.
  'task.search': READ,
  // The activity ledger (MP-8-4): reads audit events, writes nothing.
  'task.ledger': READ,
  'task.execution': READ,
  'person.list': READ,
  // The Team panel's staff list (MP-7-10).
  'team.list': READ,
  'preset.plan': READ,
  'settings.read': READ,
  'session.capabilities': READ,
  // The person menu (C23): the caller's own name; and the sign-out, which
  // writes only its audit event (the browser ends the credential itself).
  'session.person': READ,
  'session.end': READ,
  // The caller's own preferences (MP-2-11a), a row of their own in the business.
  'preference.read': READ,
  'preference.save': writing(business('person_preferences')),
  'preference.dismiss_tip': writing(business('person_preferences')),
  'access.read': READ,
  'client.list': READ,
  'operations.read': READ,
  // Drafts the notices and returns them; nothing is sent or stored.
  'privacy.draft_breach_notices': READ,
  'inbox.read': READ,
  'inbox.count': READ,
  'inbox.unattended': READ,
  // The caller's own seen stamp, on an item that points at a task.
  'inbox.seen': writing(client('inbox_attention')),
  // Validated only: in-app is always on, and nothing is stored (INB-1e).
  'notifications.set_channel': READ,
  'settings.set_four_eyes_threshold': SETTINGS,
  'settings.set_client_sign_off': SETTINGS,
  'settings.set_money_step_up': SETTINGS,
  'settings.set_conversation_window': SETTINGS,
  'settings.set_retention_window': SETTINGS,
  'privacy.record_incident': writing(business('privacy_incidents')),
  'legal.draft_version': LEGAL,
  'legal.approve_version': LEGAL,
  'legal.publish_version': LEGAL,
  'privacy.set_overseas_service': writing(business('overseas_services')),
  'privacy.set_data_class': writing(business('data_classes')),
  // The installation's own rows: no client's, so no client-scoped write.
  'operations.record_gate_item': writing(business('ops.gate_items')),
  'operations.change_installation_mode': writing(business('ops.installation')),
  'credential.issue': CREDENTIAL,
  'credential.revoke': CREDENTIAL,
  'client.create': writing(client('clients')),
  'access.grant': GRANTS,
  'access.revoke': GRANTS,
  // C58: the team member signed out and deactivated at the identity provider.
  'access.end': writing(
    business('access_endings', 'actors', 'memberships', 'grants', 'delegations'),
    [{ provider: 'identity', forClient: false }],
  ),
  'grant.revoke': GRANTS,
  'delegation.revoke': writing([
    ...client('attempts', 'leases', 'planned_runs', 'reservations', 'task_envelopes'),
    ...business('delegations'),
  ]),
  'task.cancel': writing(client('alerts', 'inbox_items', 'planned_runs', 'proposal_lineages')),
  'task.restart': PROPOSAL,
  'task.heartbeat': writing(client('leases')),
  'task.dispatch': writing(client('attempts', 'planned_steps')),
  'task.observe': writing(client('attempts')),
  'task.receipt': READ,
  'budget.top_up': writing(client('task_envelopes')),
  'budget.record_outcome': writing(client('alerts', 'attempts', 'reservations', 'task_envelopes')),
  'budget.write_off': writing(client('attempts', 'reservations', 'task_envelopes')),
};
