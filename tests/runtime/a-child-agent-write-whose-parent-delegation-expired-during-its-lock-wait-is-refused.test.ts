// SPDX-License-Identifier: AGPL-3.0-only
//
// A child delegation's call is its parent's call too, so the parent's expiry
// is judged when the child's write applies, as the child's own is. On the
// agent route, `run.revise_state` resolves the helper's child delegation,
// waits for the run row, and resolves it again once it holds it, asking the
// parent afresh. The child stays live for an hour; its parent expires a
// moment after the write is admitted. A fixture transaction holds the run
// row; the helper's write parks on it while the parent is live; the
// database's wall clock passes the parent's expiry; then the fixture lets go.
// The write must be refused `DELEGATION_EXPIRED` (the parent minted at pickup
// has run out) and append no state version: the parent's expiry is judged on
// the clock after the wait, not the transaction's start.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import {
  asAgent,
  awaitParked,
  codeOf,
  holdRows,
  racer,
  rows,
  startedBefore,
  waitPast,
} from './schedules-harness.ts';
import { child, noDatabase, parentWork, useChildWorld, w } from './aw-11-child-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useChildWorld('aw11parentexpiry');

const PARENT_EXPIRES = 'select expires_at from public.delegations where id = $1';

/** The helper's `run.revise_state` on `runId`, on its own connection, presenting `credential`. */
function reviseAsHelper(
  writer: Database,
  credential: string,
  taskId: string,
  runId: string,
): ReturnType<typeof asAgent> {
  return asAgent(
    { ...w.s, agent: w.helper.presented },
    {
      command: 'run.revise_state',
      operationId: randomUUID(),
      recordId: taskId,
      runId,
      expectedVersion: 0,
      knowledge: ['race text'],
      unknowns: [],
    },
    credential,
    writer,
  );
}

/**
 * Parks the write on the held run row while the parent is live, and returns
 * once the database clock is past the parent's expiry, the child still live.
 */
async function parkAcrossParentExpiry(parentId: string, childId: string): Promise<void> {
  await awaitParked(w.s, 'planned_runs', 1);
  // Admitted while the parent was live: the waiter's transaction began before its expiry.
  expect(
    await startedBefore(w.s, PARENT_EXPIRES, parentId),
    'the write was admitted before the parent delegation expired',
  ).toBe(true);
  await waitPast(w.s, PARENT_EXPIRES, parentId);
  // The child itself is still live: only its parent ran out.
  const [own] = await rows<{ readonly live: boolean }>(
    w.s,
    `select clock_timestamp() < expires_at as live from public.delegations
      where business_id = $1 and id = $2`,
    [w.s.business, childId],
  );
  expect(own?.live, 'the child delegation outlives its parent').toBe(true);
}

it("a child agent's run-state write whose parent delegation expired during its lock wait is refused, and appends nothing", async () => {
  const { work, parent } = await parentWork(w.s);
  const runId = String(work.picked['runId']);
  // The helper may write the run, and nothing else: strictly narrower than its parent.
  const helped = await child(w.s, parent, w.helper, {
    collections: ['run'],
    actions: ['write'],
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const writer = racer(w.s);
  const row = await holdRows(w.s, 'planned_runs', [runId]);
  let writing: ReturnType<typeof asAgent> | undefined;
  try {
    await w.s.db.admin.execute(
      `update public.delegations set expires_at = clock_timestamp() + interval '3 seconds'
        where business_id = $1 and id = $2`,
      [w.s.business, parent.id],
    );
    writing = reviseAsHelper(writer, helped.credential, work.taskId, runId);
    await parkAcrossParentExpiry(parent.id, helped.delegation.id);
  } finally {
    await row.release();
  }
  const answer = await writing;
  await writer.close();
  const versions = await rows<{ readonly n: number }>(
    w.s,
    'select count(*)::int as n from public.run_states where business_id = $1 and run_id = $2',
    [w.s.business, runId],
  );
  expect({
    answer: answer === undefined ? 'unsent' : codeOf(answer),
    versions: versions[0]?.n,
  }).toEqual({
    answer: 'DELEGATION_EXPIRED',
    versions: 0,
  });
});
