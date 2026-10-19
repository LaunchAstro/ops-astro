// SPDX-License-Identifier: AGPL-3.0-only
//
// The commands S0-5's person-path proofs cannot run: `model.call`, AW-11's
// child work, the worker's own stop and the take answer are on the agent
// prefix only, and the person path refuses them whatever the gate says.

export const AGENT_ONLY: ReadonlySet<string> = new Set([
  'model.call',
  'run.delegate_child',
  'run.child_handback',
  'run.end',
  'task.take_launch',
]);
