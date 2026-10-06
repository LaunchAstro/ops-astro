// SPDX-License-Identifier: AGPL-3.0-only
//
// Every command's name, one union. Type-only, so the command surface
// (`surface.ts`, which re-exports it) stays under the product line cap.

import type { SetupCommandName } from './surface-setup.ts';

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
  // AW-04: the plan accept, a person's one click on the plan's gate.
  | 'task.accept_plan'
  // The owning operations the task type's field definitions name.
  | 'task.start'
  | 'task.set_state'
  | 'task.duplicate'
  | 'task.assign'
  | 'task.triage'
  | 'task.set_stage'
  | 'task.set_party'
  | 'task.set_audience'
  | 'task.reparent'
  | 'task.move'
  | 'task.set_scores'
  | 'task.set_adhoc'
  | 'task.set_category'
  | 'task.share_with_client'
  | 'task.revoke_client_share'
  | 'task.edit_comment'
  | 'task.delete_comment'
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
  // The gate engine's pending decisions a person may make (MP-6-1).
  | 'gate.pending'
  // AW-04: which runs read an instruction file, by digest, and what they
  // reached: a pre-review projection, the team's only.
  | 'definition.attribution'
  // What happened to the business's tasks, by day (MP-8-4, CS-8.9): a view
  // over the applied writes in `audit_events`, never a second record of them.
  | 'task.ledger'
  | 'person.list'
  // Search over what the caller may read (C1). The grant it takes is `read`
  // on tasks at whatever scope the caller holds it, asked by the search
  // itself so the scope is part of the statement that finds candidates.
  | 'task.search'
  | 'team.list'
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
  // Who is signed in (C23): the caller's own name and nothing else, for the
  // person menu. Like `session.capabilities` it is about the caller, so it takes
  // no grant; unlike it, it answers a person who holds none, because anyone
  // signed in may see their own name.
  | 'session.person'
  // Settings ▸ Access (C32): Team, Clients and Agents from the one set of
  // person records, each with what its grants and delegations allow now.
  | 'access.read'
  | 'client.list'
  // C55: the operations view, the one read of what needs the operator's eye.
  | 'operations.read'
  // C81: the breach drill's notices, drafted from the published runbook.
  | 'privacy.draft_breach_notices'
  // The two settings the model classifies `operation`. A setting that decides
  // who must agree before money moves or before work completes is an authority
  // change wearing configuration's clothes, so it is not reachable through a
  // generic edit and a named command owns it. The names are the ones the
  // `business_settings` rows already cite in `owning_operation`.
  | 'settings.set_four_eyes_threshold'
  | 'settings.set_client_sign_off'
  // C59: whether a money action needs a recent second-factor sign-in.
  | 'settings.set_money_step_up'
  // MP-2-11: the conversation and retention windows, in days (C122-1).
  | 'settings.set_conversation_window'
  | 'settings.set_retention_window'
  // C55: the breach runbook's day-0 record, `privacy incident recorded`.
  | 'privacy.record_incident'
  // C81: the legal documents' versions, drafted, approved as those exact
  // bytes, and published.
  | 'legal.draft_version'
  | 'legal.approve_version'
  | 'legal.publish_version'
  // API-2: an agent credential, issued and revoked by a person on their own
  // account.
  | 'credential.issue'
  | 'credential.revoke'
  // C81: the overseas-services register the privacy policy reads.
  | 'privacy.set_overseas_service'
  // C81: the data-class register the privacy policy reads.
  | 'privacy.set_data_class'
  // S0-5: the first-client gate's own acts, `gate item recorded` and
  // `installation mode changed`.
  | 'operations.record_gate_item'
  | 'operations.change_installation_mode'
  // The support controls the contract ledger requires through owning
  // production interfaces: revocation of an existing grant or delegation,
  // cancellation of a run's lineage, an authorised restart as a new lineage,
  // and the lease owner's heartbeat. None is a new actor power; each asks for
  // authority the caller already holds (see each row below).
  | 'client.create'
  // New client onboarding (C41-A): record.create, onboarding.start and onboarding.step_result.
  | 'record.create'
  | 'onboarding.start'
  | 'onboarding.step_result'
  // C60: a client's privacy settings, on its record.
  | 'client.set_privacy'
  | 'access.grant'
  | 'access.revoke'
  | 'access.end'
  // C59 (ORCH65-Q3): the owner clears a member's lost authenticator.
  | 'access.reset_factor'
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
  | 'budget.write_off'
  // Wayfinder (WF-1): a map is a task of type `map`, its tickets its subtasks.
  // Retyping to or from grilling, prototype or map also asks the owner's `decide`.
  | 'task.set_type'
  | 'map.revise'
  | 'map.scope'
  | 'map.view'
  // WF-2: chart a map, a ticket's blocking, claim and close, and fog graduating.
  | 'map.chart'
  | 'task.set_blocking'
  | 'task.claim'
  | 'map.graduate'
  | 'task.resolve'
  | 'task.close_out_of_scope'
  // WF-2: a map's frontier and fog, from their read models.
  | 'map.frontier'
  // AW-04 (U10): a person sets the business's planning cap, the allowance the
  // planning replies spend before the accept.
  | 'budget.set_planning_cap'
  // A check the run performed, recorded under its worker lease (MP-6-1,
  // CS-16.3): a system write whose authority is the live lease, not a grant.
  | 'task.check'
  // A person's conversation with the agent (AW-03): minted at its first
  // message, its owner's alone, and read at its address after the body purges.
  | 'conversation.start'
  | 'conversation.message'
  | 'conversation.read'
  // The assistant panel's tab row (MP-7-11): the person's own conversations,
  // a tab's title, and the page it is about.
  | 'conversation.list'
  // AW-04 (U10): the drawer's planning allowance line.
  | 'conversation.allowance'
  | 'conversation.rename'
  | 'conversation.set_scope'
  // One priced model call, made by the lease holder through the credential
  // broker (AW-01). The grant is the run's delegation, one of the six facts
  // the broker verifies from rows; no person grant carries it.
  | 'model.call'
  // A person's two answers to a run waiting at its approved ceiling (AW-05):
  // a top-up under four eyes above the business's threshold, or one click
  // that ends the work and parks the task. No agent answers either.
  | 'run.top_up'
  | 'run.end_at_budget_stop'
  // A run's current knowledge and unknowns, revised as a new version (MP-6-2,
  // CS-16.4): `run:write` on the run's task, a person's or an agent's inside
  // its delegation, the agent the recorded actor.
  | 'run.revise_state'
  // AW-11: the parent's holder hands part of its work to a helper that can do
  // strictly less, and the helper hands its result back. Both agents only.
  | 'run.delegate_child'
  | 'run.child_handback'
  // Time tracking (MP-4-6): a person's own time entries on a task, under
  // `time:write`. None names the task's revision: a time entry is a row
  // beside the task, not a write to it.
  | 'time.start'
  | 'time.stop'
  | 'time.log'
  | 'time.set_note'
  | 'time.delete'
  // Tags (MP-4-11): a name in the business's vocabulary under `tag:write`,
  // and a task's tags under `task:write` on the task. Neither names the
  // task's revision: a tag is a row beside the task, not a write to it.
  | 'tag.create'
  | 'task.add_tag'
  | 'task.remove_tag'
  | 'tag.list'
  // The reader's own to-dos (MP-7-1): open tasks assigned to the reader.
  | 'task.todos'
  // Sign-out (C23, CS-2.9): records `session ended (sign-out)` on the audit
  // chain. `account:write`, which every signed-in person holds on their own
  // account and nobody holds on another's, so it names no one: the account is
  // the caller's, always.
  | 'session.end'
  // The one preference store (MP-2-11a): the caller's own keys.
  | 'preference.read'
  | 'preference.save'
  | 'preference.dismiss_tip'
  // The inbox inside Tasks (INB-1d): the caller's own items and owed count,
  // and `seen` stamped on the caller's own attention row.
  | 'inbox.read'
  | 'inbox.count'
  | 'inbox.seen'
  // Items no path reaches, for the operations view (INB-1e), and the caller's
  // own notification setting on one channel.
  | 'inbox.unattended'
  | 'notifications.set_channel'
  // Team conversations (C71-D): a direct message on the one comment record,
  // the reader's conversations and one conversation's messages, and the
  // reader's own read marker.
  | 'chat.send_direct'
  | 'chat.conversations'
  | 'chat.messages'
  | 'chat.mark_read'
  // A run's trace, as the export sends it (AW-13 readers), for `operations:read`.
  | 'trace.read'
  // The harness adoption test's result on one run (AW-12): the team's.
  | 'harness.read'
  // C39-T: a team invitation made, sent again and withdrawn under
  // `access:share`; its expiry is the business's worker's, never a command.
  | 'invitation.create'
  | 'invitation.resend'
  | 'invitation.revoke'
  // Settings ▸ Workflow triggers (C33): the registry is one read by
  // `settings:read`; changing an activation is `settings:manage` and releasing
  // a definition version `automation:manage`, neither an agent's.
  | 'automation.registry'
  | 'activation.change'
  | 'definition.release'
  // Standing approvals (C52-A): adopting a version, rolling back, turning off
  // and revoking an approval, each `automation:manage` and never an agent's.
  | 'activation.adopt'
  | 'activation.roll_back'
  | 'activation.turn_off'
  | 'approval.revoke'
  // Setup's operations (C31 on), in `surface-setup.ts`.
  | SetupCommandName;
