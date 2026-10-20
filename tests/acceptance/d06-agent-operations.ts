// SPDX-License-Identifier: AGPL-3.0-only
//
// D06 on the agent prefix (`d06-agent.test.ts`): the operations with a positive
// control and what a valid one answers (moved whole for the line cap).

import type { CommandName } from '../../packages/core-wire/src/surface.ts';

/** The agent's operations with a positive control, in the order the journey needs them. */
export const AGENT_OPERATIONS: readonly CommandName[] = [
  'task.queue',
  'session.capabilities',
  'task.read',
  'task.comment',
  'task.propose',
  'run.revise_state',
  // An author's edit and delete (MP-4-5), each on a comment the agent wrote.
  'task.edit_comment',
  'task.delete_comment',
  // The three marks (MP-4-9), the Ad hoc mark (MP-4-10) and the category
  // (MP-4-8), which an agent sets on its own task inside its delegation.
  'task.set_scores',
  'task.set_adhoc',
  'task.set_category',
  // The description and the brief (MP-4-7), the name, the due date and the
  // page link (MP-4-8, MP-4-12): the fields an agent writes through
  // `task.update` on its own task.
  'task.update',
  // The assignee (MP-4-8), under a delegation that also holds assign.
  'task.assign',
  'live_correction.request',
  'task.heartbeat',
  'task.dispatch',
  'task.observe',
  'task.check',
  'model.call',
  'run.delegate_child',
  'run.child_handback',
  // C35's worker writes: a capture claimed on the held lease's task, landed under it, and
  // the pins carried onto it (#2075).
  'review.capture_claim',
  'review.capture_land',
  'review.carry_pins',
  'task.pickup',
  'task.handback',
  // The worker's own stop (#1623 R1): its success is the retained `RUN_ENDED`.
  'run.end',
  // An onboarding step's result (C41-A), on a step the agent picked up.
  'onboarding.step_result',
];

/** What a valid request answers: `ok`, or `run.end`'s retained stop. */
export const success = (name: CommandName): string => (name === 'run.end' ? 'RUN_ENDED' : 'ok');
