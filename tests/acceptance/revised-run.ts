// MP-6-2's positive control for `run.revise_state` (role-case-positive-body):
// the planned run a proposal made, its state revised by a holder of run:write
// on its task (the harness tops the admin up).

import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import type { Answer } from './world.ts';

export async function revisedRunBody(
  context: {
    freshTask(title: string): Promise<{ readonly id: string; readonly revision: number }>;
    asPerson(name: CommandName, body: Readonly<Record<string, unknown>>): Promise<Answer>;
  },
  proposal: Readonly<Record<string, unknown>>,
): Promise<{ readonly body: Record<string, unknown> } | { readonly exception: string }> {
  const task = await context.freshTask('a run whose state is revised');
  const proposed = await context.asPerson('task.propose', {
    recordId: task.id,
    expectedRevision: task.revision,
    ...proposal,
  });
  if (proposed.code !== 'ok') return { exception: `propose refused ${proposed.code}` };
  const detail = proposed.body['detail'] as Record<string, unknown>;
  return {
    body: {
      recordId: task.id,
      runId: String(detail['runId']),
      expectedVersion: 0,
      knowledge: ['the brief is agreed'],
      unknowns: ['the launch date'],
    },
  };
}
