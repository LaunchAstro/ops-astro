// SPDX-License-Identifier: AGPL-3.0-only
//
// OW-108.1, security review low on e90c93f: the task read itself carries the
// attempt's recorded outcome, so a completed hand-back reads Done. Dropping the
// column from the proposal read turns this case red, which Sol's failed-only
// proof cannot see.

import { describe, expect, it } from 'vitest';
import { runStories } from '../../packages/ui/src/state/agent-run.ts';
import type { RunLineage } from '../../packages/ui/src/state/run-projection.ts';
import { clearingWorld, detailOf, ok } from '../commands/inbox-clearing-world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

type World = ReturnType<typeof clearingWorld>;

/** Propose, approve, pick up and hand back with `outcome`, then read the task's runs. */
async function handedBack(w: World, outcome: 'completed'): Promise<RunLineage[]> {
  const p = await w.proposed(`The worker hands back ${outcome}`);
  const decide = { gateId: p.gateId, versionId: p.versionId, decision: 'approve', note: 'go' };
  const approved = detailOf(ok(await w.call('task.decide', decide, w.reviewerToken)));
  const pickup = { reservationId: approved['reservationId'], leaseSeconds: 600 };
  const picked = detailOf(ok(await w.call('task.pickup', pickup, w.writerToken)));
  const handback = { leaseId: picked['leaseId'], fence: picked['fence'], outcome };
  ok(await w.call('task.handback', handback, w.writerToken));
  const read = ok(await w.call('task.read', { recordId: p.task.id }));
  return (read.body['task'] as { proposals: RunLineage[] }).proposals;
}

const outcomeOf = (proposals: RunLineage[]) =>
  proposals.at(-1)?.reservations.at(-1)?.attempt?.outcome;

describe.skipIf(databaseUrlFromEnvironment() === undefined)('the read carries the outcome', () => {
  const w = clearingWorld('g1c_handback_outcome_read');

  it('a completed hand-back reads completed and its story is Done', async () => {
    const proposals = await handedBack(w, 'completed');
    expect(outcomeOf(proposals)).toBe('completed');
    expect(runStories(proposals).at(-1)?.state).toBe('done');
  });
});
