// SPDX-License-Identifier: AGPL-3.0-only
//
// The S0-5 content commands whose marker is a row naming the task rather than
// a new task revision, split out of `s0-5-client-lock-world.ts` so that file
// stays under the per-file size cap.

/**
 * Held (the marker's second half): these commands run under the runtime's own
 * lock order (cap, envelope, then task) or write a row other than the task, and
 * leave no history event with a new revision on the task. Their content is
 * found by the rows that name the task, which the lock reads; the marker on
 * each waits for the runtime's lock order to take the task first.
 */
export const MARKER_HELD: ReadonlySet<string> = new Set([
  'task.comment',
  'task.propose',
  'task.decide',
  'task.pickup',
  'task.handback',
  'task.restore',
  'delegation.revoke',
  'task.cancel',
  'task.restart',
  'task.heartbeat',
  'task.dispatch',
  'task.observe',
  'budget.top_up',
  'budget.record_outcome',
  'budget.write_off',
  // SL12 (batch 3a): each acts on a run the task already holds.
  'task.check',
  'run.top_up',
  'run.end_at_budget_stop',
  'run.revise_state',
  // The task's own rows beside it (MP-4-5 comments, MP-4-6 time, MP-4-11 tags, C41-A):
  // a comment's edit or removal, a time entry, a tag, a step's result as a comment.
  'task.edit_comment',
  'task.delete_comment',
  'time.start',
  'time.stop',
  'time.log',
  'time.set_note',
  'time.delete',
  'task.add_tag',
  'task.remove_tag',
  'onboarding.step_result',
  // SL11 (batch 3b): approves the proposal's gate as `task.decide` does, then pins and binds.
  'task.accept_plan',
  // C80: a request files a correction naming the task, and a decision moves it.
  'live_correction.request',
  'live_correction.decide',
  'live_correction.revert',
  // R5: a review files a row naming a correction, which names the task.
  'live_correction.record_review',
  // C35: a review names the task, its revisions and captures lead back to it; the task keeps its revision.
  // A worker's claim and land act on a lease the task already holds, and on the review's captures.
  'review.capture_claim',
  'review.capture_land',
  'review.open',
  'review.capture',
  // A pin is a comment on the review's task (#2012).
  'review.pin_comment',
  // C57: a change request names its pin's task (#2016).
  'review.propose_change',
  'review.decide_change',
  // Launch from the task: a launch row and its delegation name the task; the task keeps its revision.
  'task.launch',
]);
