// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's `task.launch` recipe: a fresh task held by an agent
// the caller owns, seeded by the harness (`launchableTask`), launched at its
// revision. A harness with no such seed records an exception rather than a
// refusal.

import type { BodyContext, Prepared } from './role-case-bodies.ts';

export async function launchBody(context: BodyContext, author?: unknown): Promise<Prepared> {
  if (context.launchableTask === undefined)
    return { exception: 'no agent the caller directs here' };
  const task = await context.launchableTask(author);
  return { body: { recordId: task.id, expectedRevision: task.revision } };
}
