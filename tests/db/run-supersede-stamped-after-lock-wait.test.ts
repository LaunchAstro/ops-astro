// SPDX-License-Identifier: AGPL-3.0-only
//
// A claimed run whose plan version is replaced has no stamped end of its own:
// conversation-work.ts `runWork` reads its end from the version's
// `superseded_at`. A propose waits on the run's row lock before it supersedes,
// so the supersede must not be stamped earlier than the instant that lock
// released, or the conversation's body becomes purge-due before its window
// has run from the run's real end.

import { expect, it } from 'vitest';
import { awaitParked, barrier, racer } from '../runtime/schedules-harness.ts';
import { s, useBrokerWorld } from '../broker/broker-world.ts';
import { one, stopped, usePeople } from '../broker/budget-answers-world.ts';

useBrokerWorld('supersedelockwait');
usePeople();

it('a supersede that waited on the run lock is not stamped before the lock released', async () => {
  const { runId } = await stopped('supersede after a lock wait');
  const { lineage_id: lineageId, version_id: versionId } = await one<{
    lineage_id: string;
    version_id: string;
  }>('select lineage_id, version_id from public.planned_runs where id = $1', [runId]);
  const holderDb = racer(s);
  const proposerDb = racer(s);
  const locked = barrier();
  const gate = barrier();
  let releaseAt!: Date;
  try {
    // Connection A: hold the run row, as a model call on the run does.
    const holding = holderDb.withBusiness(s.business, async (tx) => {
      await tx.query(
        `select 1 from public.planned_runs where business_id = $1 and id = $2 for update`,
        [tx.businessId, runId],
      );
      locked.release();
      await gate.held;
      const [row] = await tx.query<{ at: Date }>(`select clock_timestamp() as at`);
      if (row === undefined) throw new Error('no clock');
      releaseAt = row.at;
    });
    await locked.held;

    // Connection B: the propose's order, the run lock first, then the
    // supersede statement proposal-writer.ts writes.
    const proposing = proposerDb.withBusiness(s.business, async (tx) => {
      await tx.query(
        `select 1 from public.planned_runs where business_id = $1 and id = $2 for update`,
        [tx.businessId, runId],
      );
      await tx.query(
        `update public.proposal_versions set superseded_at = now()
          where business_id = $1 and lineage_id = $2 and superseded_at is null`,
        [tx.businessId, lineageId],
      );
    });
    await awaitParked(s, 'planned_runs', 1);
    await new Promise((resolve) => {
      setTimeout(resolve, 1000);
    });
    gate.release();
    await holding;
    await proposing;
  } finally {
    await holderDb.close();
    await proposerDb.close();
  }

  const stamped = await one<{ superseded_at: Date; at_or_after_release: boolean }>(
    `select superseded_at, superseded_at >= $2::timestamptz as at_or_after_release
       from public.proposal_versions where id = $1`,
    [versionId, releaseAt],
  );
  expect(
    stamped.at_or_after_release,
    `superseded_at ${stamped.superseded_at.toISOString()} vs releaseAt ${releaseAt.toISOString()}`,
  ).toBe(true);
});
