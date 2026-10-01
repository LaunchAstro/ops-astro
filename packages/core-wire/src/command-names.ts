// SPDX-License-Identifier: AGPL-3.0-only
//
// Every command's name, one union. Type-only, so the command surface
// (`surface.ts`, which re-exports it) stays under the product line cap.

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
  | 'task.set_state'
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
  | 'access.grant'
  | 'access.revoke'
  | 'access.end'
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
  | 'notifications.set_channel';
