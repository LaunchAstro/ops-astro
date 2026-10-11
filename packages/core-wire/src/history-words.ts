// SPDX-License-Identifier: AGPL-3.0-only
//
// A task's history in words (MP-4-16, U116). One list of the commands that
// are changes to a task, and one of the task fields a change may name, each
// with the words a person reads. The server's history read keeps only these
// (`historyOf`), and the task page draws them, so the two cannot disagree.

/**
 * The commands that change a task, as the history names them. Anything else
 * on the task's address is not in its history: reads, comments and their
 * edits, time and its notes, preferences, and an agent run's checks and
 * observations. A command added later stays out until it is listed here.
 */
export const HISTORY_OPERATIONS: Readonly<Record<string, string>> = {
  'task.create': 'Created',
  'task.duplicate': 'Duplicated',
  'task.update': 'Details changed',
  'task.assign': 'Assigned',
  'task.start': 'Started',
  'task.complete': 'Completed',
  'task.reopen': 'Reopened',
  'task.set_state': 'Status changed',
  'task.cancel': 'Cancelled',
  'task.restart': 'Restarted',
  'task.triage': 'Triaged',
  'task.set_stage': 'Stage set',
  'task.set_party': 'Client set',
  'task.set_audience': 'Audience set',
  'task.set_scores': 'Rank marks set',
  'task.set_adhoc': 'Ad hoc changed',
  'task.set_category': 'Category changed',
  'task.set_type': 'Type changed',
  'task.set_blocking': 'Blocking changed',
  'task.reparent': 'Moved under another task',
  'task.move': 'Moved',
  'task.rank': 'Reordered',
  'task.add_tag': 'Tag added',
  'task.remove_tag': 'Tag removed',
  'task.share_with_client': 'Shared with the client',
  'task.revoke_client_share': 'Client access withdrawn',
  'task.propose': 'Proposed',
  'task.decide': 'Decided',
  'task.accept_plan': 'Plan accepted',
  'task.pickup': 'Picked up',
  'task.handback': 'Handed back',
  'task.claim': 'Claimed',
  'task.resolve': 'Resolved',
  'task.close_out_of_scope': 'Closed as out of scope',
  'task.trash': 'Moved to the bin',
  'task.restore': 'Restored',
  'onboarding.start': 'Onboarding started',
  'map.chart': 'Map created',
  'map.revise': 'Map revised',
  'map.scope': 'Map scope changed',
  'map.graduate': 'Graduated from the map',
};

/**
 * The task fields a history entry may name, by the key the audit event
 * recorded (`audit_events.field_changes`). A key not listed here, a custom
 * field's included, is never sent: the change is told by its command alone.
 */
export const HISTORY_FIELDS: Readonly<Record<string, string>> = {
  title: 'Title',
  description: 'Description',
  due: 'Due date',
  priority: 'Priority',
  estimated_minutes: 'Estimate',
  page_link: 'Page link',
  agent_brief: 'Agent brief',
  category: 'Category',
  ad_hoc: 'Ad hoc',
  board: 'Board',
  board_section: 'Board section',
  lane: 'Lane',
  stage: 'Stage',
  state: 'Status',
  intake_state: 'Intake',
  assignee: 'Assignee',
  delegate: 'Delegate',
  agent: 'Agent',
  parent: 'Parent task',
  client: 'Client',
  client_visible: 'Client access',
  type: 'Type',
  started_at: 'Start date',
  completed_at: 'Completion date',
  impact: 'Impact',
  confidence: 'Confidence',
  ease: 'Ease',
};
