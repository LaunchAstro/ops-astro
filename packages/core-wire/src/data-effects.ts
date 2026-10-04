// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: what each command does to data, declared beside its permission key.
// Its shapes and the class the gate reads, derived from it and never set by
// hand, are in `data-effects-types.ts`, re-exported here.

import type { CommandName } from './surface.ts';
import type { DataEffects, OutsideEffect, RecordWrite } from './data-effects-types.ts';

export type {
  ClassedEffects,
  DataClass,
  DataEffects,
  EffectScope,
  Intake,
  OutsideEffect,
  RecordWrite,
} from './data-effects-types.ts';
export { classOf } from './data-effects-types.ts';

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
// A map or its ticket: the task, and the map's derived summary and frontier.
const MAP_TASK = writing(
  client('records', 'record_unique_values', 'map_summaries', 'map_frontier'),
);
// A proposal raises the decision's inbox items (INB-1b).
const PROPOSAL = writing(
  client(
    'evidence_packs',
    'gates',
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
// A task shared with its client is that client's data reaching the client's
// existing people: S0-5 classes it client-data, never an invitation, as it
// enrols no one (MP-4-10). Taking the share back gives no one
// anything, so `task.revoke_client_share` stays a business grant write.
const SHARE = writing(client('grants'));
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
  // AW-09: the lease holder's revision of its output is the reviewed output too.
  // A restart opens a new lineage, which supersedes nothing, so it marks none.
  'task.propose': writing([...PROPOSAL.writes, ...client('reviewed_outputs')]),
  'task.decide': writing(
    client('attempts', 'gate_decisions', 'gates', 'inbox_items', 'reservations', 'task_envelopes'),
  ),
  // An agent's pickup also mints its delegation. A step whose calls spent its
  // whole hold stops at its budget instead (AW-05): the ask, and after the
  // run's last ask a person told on the task.
  'task.pickup': writing([
    ...client('alerts', 'attempts', 'budget_asks', 'leases', 'planned_runs', 'reservations'),
    ...client('run_events'),
    ...business('delegations'),
  ]),
  // A successor is a proposal on the lineage, and the reviewed output (AW-08).
  'task.handback': writing([
    ...client('alerts', 'attempts', 'evidence_packs', 'gates', 'handback_reports', 'inbox_items'),
    ...client('leases', 'planned_runs', 'planned_steps', 'proposal_versions', 'reservations'),
    ...client('reviewed_outputs', 'run_events', 'task_envelopes'),
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
  // A duplicate is a new task with its subtasks and a link to the old one (MP-4-8).
  'task.duplicate': writing(client('records', 'record_unique_values', 'record_links')),
  // Client access (MP-4-10): a share grant on the task for its client's people.
  'task.share_with_client': SHARE,
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
  'client.set_privacy': writing(client('clients')),
  // SL12 (batch 3a join, BATCH3-INTEG): a conversation can hold a task's
  // content once scoped to it, so its rows count as client-scoped.
  'gate.pending': READ,
  'conversation.read': READ,
  'conversation.list': READ,
  'conversation.start': writing(client('conversations', 'conversation_messages')),
  'conversation.message': writing(client('conversations', 'conversation_messages')),
  'conversation.rename': writing(client('conversations')),
  'conversation.set_scope': writing(client('conversations')),
  // AW-01: the broker's hold on the lease's run and its prompt copy's
  // registration. At the approved ceiling the refusal commits the stop instead
  // (AW-05): the ask, the lease released, the delegation retired, the run
  // waiting. The provider call goes through the credential broker; a client's
  // task never reaches a route (C60), so it is the business's own.
  'model.call': writing(
    [
      ...client('model_calls', 'budget_asks', 'leases', 'planned_runs'),
      ...business('copy_registrations', 'delegations'),
    ],
    [{ provider: 'model', forClient: false }],
  ),
  // AW-05: the two answers at the budget stop, and MP-6-2's state revised.
  // None of the four below writes `run_events`: only pickup, hand-back and a drop append it.
  // At a hold its calls spent whole, the top-up is the step's fresh hold: a new attempt.
  'run.top_up': writing([
    ...client('attempts', 'budget_answers', 'budget_approvals', 'planned_runs', 'reservations'),
    ...client('task_envelopes'),
  ]),
  'run.end_at_budget_stop': writing(
    client('budget_answers', 'planned_runs', 'reservations', 'task_envelopes'),
  ),
  'run.revise_state': writing(client('run_states')),
  // MP-6-1's check on a task's run.
  'task.check': writing(client('run_checks')),
  // SL11 (batch 3b join, BATCH3-INTEG): AW-04's reads and planning cap,
  // AW-13's trace read, AW-12's harness result, AW-11's child work, and the
  // accepted plan.
  'conversation.allowance': READ,
  'definition.attribution': READ,
  'trace.read': READ,
  'harness.read': READ,
  'budget.set_planning_cap': writing(business('budget_caps', 'business_settings')),
  'run.delegate_child': writing([...client('run_events'), ...business('delegations')]),
  'run.child_handback': writing([...client('run_events'), ...business('delegations')]),
  'task.accept_plan': writing(
    client(
      'attempts',
      'gate_decisions',
      'gates',
      'inbox_items',
      'plan_records',
      'reservations',
      'run_definition_pins',
      'run_events',
      'task_envelopes',
    ),
  ),
  'access.grant': GRANTS,
  'access.revoke': GRANTS,
  // C58: the team member signed out and deactivated at the identity provider.
  'access.end': writing(
    business(
      'access_endings',
      'actors',
      'agent_credentials',
      'memberships',
      'grants',
      'delegations',
    ),
    [{ provider: 'identity', forClient: false }],
  ),
  // C59: a factor cleared here and at the provider, kept by subject and session (0061, 0063, 0064).
  'access.reset_factor': writing(
    business(
      'factor_resets',
      'second_factors',
      'people',
      'ended_sessions',
      'ops.second_factor_subjects',
      'ops.ended_subject_sessions',
      'ops.ended_provider_sessions',
    ),
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
  // AW-10: the step's held calls take the outcome. A replacement stopped, or a
  // resume at a hold its calls spent whole, ends the lease and the delegation
  // and stops the run at its budget (AW-05).
  'budget.record_outcome': writing([
    ...client('alerts', 'attempts', 'budget_asks', 'leases', 'model_calls', 'planned_runs'),
    ...client('reservations', 'task_envelopes'),
    ...business('delegations'),
  ]),
  'budget.write_off': writing(client('attempts', 'model_calls', 'reservations', 'task_envelopes')),
  // Wayfinder (WF-1): a retype writes the task, and a grilling or prototype
  // ticket newly on its map's frontier raises the owner's decision item. A
  // write to a map or its ticket refreshes the map's summary and frontier
  // (the records trigger, map_summary_on_record).
  'task.set_type': writing(MAP_TASK.writes.concat(client('inbox_items'))),
  // The map and every ticket under it carry the client.
  'map.scope': MAP_TASK,
};
