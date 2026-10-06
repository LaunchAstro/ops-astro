// SPDX-License-Identifier: AGPL-3.0-only
//
// A decision is bound to its version's purpose, payload and payload digest:
// the task read recomputes the digest from the signed evidence body, as the
// proposal writer computed it. A run proposed under a plan step digests its
// step's key too, so an approved one must still read back as decided, through
// the production read entry, and not as a broken decision.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { ProposalView } from '../../packages/core-wire/src/index.ts';
import { appliedDetail, approveBody, asPerson, createTask } from './schedules-harness.ts';
import { acceptPlanOn, noDatabase, proposeStep, useAw06World, w } from './aw-06-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useAw06World('planread');

it('an approved run proposed under a plan step reads back as decided', async () => {
  const taskId = await createTask(w.s, `planread-${randomUUID()}`);
  await acceptPlanOn(taskId);
  const planned = appliedDetail(
    await proposeStep(taskId, { kind: 'synthetic_comment', payload: {}, planStep: 'draft' }),
    'propose under draft',
  );
  appliedDetail(await asPerson(w.s, approveBody(planned)), 'task.decide approve');

  const read = await executeRead(w.s.db.app, w.s.business, w.s.decider.presented, {
    read: 'task.read',
    recordId: taskId,
  });
  expect(read).not.toHaveProperty('code');
  const proposals = (read as { readonly task: { readonly proposals: readonly ProposalView[] } })
    .task.proposals;
  const decided = proposals.find((proposal) => proposal.lineageId === planned['lineageId']);
  expect(decided?.decisions).toHaveLength(1);
});
