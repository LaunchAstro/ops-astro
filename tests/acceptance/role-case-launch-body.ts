// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's `task.launch` recipe: a fresh task handed to the
// first agent the caller may direct (`task.read`'s `myAgents`), then launched
// at the assignment's revision. A harness with no agent the caller directs
// records an exception rather than a refusal.

import type { BodyContext, Prepared } from './role-case-bodies.ts';

export async function launchBody(context: BodyContext): Promise<Prepared> {
  const task = await context.freshTask('a task to launch its agent on');
  const read = await context.asPerson('task.read', { recordId: task.id });
  const offered = (read.body['task'] as { myAgents?: { agentId: string }[] } | undefined)
    ?.myAgents?.[0];
  if (offered === undefined) return { exception: 'no agent the caller directs here' };
  const assigned = await context.asPerson('task.assign', {
    recordId: task.id,
    expectedRevision: task.revision,
    fields: { agent: offered.agentId },
  });
  return { body: { recordId: task.id, expectedRevision: Number(assigned.body['revision']) } };
}
