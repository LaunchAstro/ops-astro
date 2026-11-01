// SPDX-License-Identifier: AGPL-3.0-only
//
// API-1 isolation, the review commands under a live delegation (C35, #2011; #2368). The
// open and the capture ask reach an agent only through its person's envelope, never a
// pickup's one-task delegation (`review-agent.ts`), so both refuse outside its purpose, as
// `task.create` does. The claim and the land are the worker's, asked of the lease's task as
// `task.check` is: another person's live lease refuses for the delegation's reason, and the
// agent's own lease reaches its own capture. Each picked-up task carries a review with both
// widths asked, so a crossing names the other person's real revision and the control the
// agent's own. Registered inside api-1-isolation.test.ts's describe. Made-up names only.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import type { CatalogueRow } from '../../packages/core-wire/src/index.ts';
import type { Member } from '../commands/fixture.ts';
import { LANDING, seedForeignReview } from '../acceptance/c35-bodies.ts';
import {
  delegatedTask,
  fixture,
  foreignTaskId,
  other,
  ownLease,
  rows,
} from './api-1-isolation-world.ts';
import { asAgent } from './api-1-isolation-surfaces.ts';

interface Lease {
  readonly leaseId: string;
  readonly fence: unknown;
}

/** The planted revision on each picked-up task: the agent's own, and the other person's. */
export const revision = { own: '', foreign: '' };

/** Each review command's body, at `lease` and `revisionId`; an open names the crossing's task. */
export const reviewBodies = (
  lease: Lease,
  revisionId: string,
): Record<string, (record: string) => Record<string, unknown>> => ({
  'review.open': (record) => ({
    taskId: record,
    pageUrl: LANDING.observation['url'],
    path: 'about',
    sourceRevision: `rev-${randomUUID()}`,
  }),
  'review.capture': () => ({ revisionId }),
  'review.capture_claim': () => ({ ...lease, revisionId }),
  'review.capture_land': () => ({ ...lease, revisionId, ...LANDING }),
});

/** Every review crossing refuses for the delegation's reason, never a missing record. */
export const REVIEW_REASONS: Record<string, string> = Object.fromEntries(
  ['review.open', 'review.capture', 'review.capture_claim', 'review.capture_land'].map(
    (command) => [command, 'DELEGATION_OUT_OF_PURPOSE'],
  ),
);

/** A review on `taskId` with its first revision and both widths asked. */
async function asked(taskId: string, by: Member): Promise<string> {
  const { revisionId } = await seedForeignReview(fixture.db.admin, fixture.business, taskId, by);
  for (const width of [1480, 390]) {
    // eslint-disable-next-line no-await-in-loop -- two rows, one connection
    await fixture.db.admin.execute(
      `insert into public.review_captures
         (business_id, id, revision_id, width, asked_by_actor_id, asked_by_person_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [fixture.business, randomUUID(), revisionId, width, by.actorId, by.personId],
    );
  }
  return revisionId;
}

/** Registers the planted reviews; after `useIsolationWorld`, whose picked-up tasks they sit on. */
export function useReviews(): void {
  beforeAll(async () => {
    revision.own = await asked(delegatedTask, fixture.member);
    revision.foreign = await asked(foreignTaskId, other.person);
  });
}

const captures = async (revisionId: string) =>
  await fixture.db.admin.execute<{ width: number; state: string; lease_id: string | null }>(
    `select width, state, lease_id::text from public.review_captures
      where business_id = $1 and revision_id = $2 order by width`,
    [fixture.business, revisionId],
  );

export function reviewCrossingControl(): void {
  it('API-1 isolation: the review crossings opened, asked, claimed and landed nothing', async () => {
    const reviews = await fixture.db.admin.execute<{ reviews: number; revisions: number }>(
      `select (select count(*) from public.reviews)::int as reviews,
              (select count(*) from public.review_revisions)::int as revisions`,
    );
    expect(reviews).toEqual([{ reviews: 2, revisions: 2 }]);
    expect(await captures(revision.foreign)).toEqual([
      { width: 390, state: 'requested', lease_id: null },
      { width: 1480, state: 'requested', lease_id: null },
    ]);
  });

  it('API-1 isolation: the agent claims and lands a capture under its own delegated lease', async () => {
    const ours = reviewBodies(ownLease, revision.own);
    for (const command of ['review.capture_claim', 'review.capture_land']) {
      const row = rows.find((one) => one.command === command) as CatalogueRow;
      // eslint-disable-next-line no-await-in-loop -- the land needs the claim
      const heard = await asAgent(row, 'alpha', ours[command]?.(delegatedTask) ?? {});
      expect(
        heard.map((one) => one.status),
        `${command} ${JSON.stringify(heard)}`,
      ).toEqual([200, 200]);
    }
    expect((await captures(revision.own)).map((one) => [one.width, one.state])).toEqual([
      [390, 'claimed'],
      [1480, 'landed'],
    ]);
  });
}
