// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2103): what an agent writes under a `review:write` delegation names the agent's own
// actor as the writer, its delegating person as the person it wrote for, and the delegation it
// acted under. The review, its revision and both captures say so; none names the person's
// own actor, so an agent's write never reads as the person's.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { ABOUT, PAGE, c35World, type C35World } from './c35-world.ts';
import { delegateReview } from './c35-delegated.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 agent attribution: DATABASE_URL is unset.');

let w: C35World;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35attributed');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

type Row = Readonly<Record<string, string | null>>;

/** The rows as plain objects: the driver's rows compare unequal under `toStrictEqual`. */
const rowsOf = async (sql: string, id: unknown): Promise<readonly Row[]> =>
  (await w.world.db.admin.execute<Row>(sql, [w.world.business, id])).map((row) =>
    Object.assign({}, row),
  );

/** Who each C35 row the open and its capture wrote names: actor, person and delegation. */
const writersOf = async (reviewId: unknown, revisionId: unknown) => ({
  review: await rowsOf(
    `select opened_by_actor_id as actor, opened_by_person_id as person,
            delegation_id as delegation
       from public.reviews where business_id = $1 and id = $2`,
    reviewId,
  ),
  revision: await rowsOf(
    `select created_by_actor_id as actor, created_by_person_id as person,
            delegation_id as delegation
       from public.review_revisions where business_id = $1 and id = $2`,
    revisionId,
  ),
  captures: await rowsOf(
    `select asked_by_actor_id as actor, asked_by_person_id as person
       from public.review_captures where business_id = $1 and revision_id = $2`,
    revisionId,
  ),
});

describe.skipIf(serverUrl === undefined)('C35 an agent review write, attributed', () => {
  it('names the agent as writer, its delegating person and its delegation', async () => {
    const delegation = await delegateReview(w, w.ava, w.taskA);
    const opened = await w.world.asAgent(
      {
        command: 'review.open',
        operationId: randomUUID(),
        taskId: w.taskA,
        pageUrl: PAGE,
        path: ABOUT,
        sourceRevision: 'agent-rev',
      },
      delegation.credential,
    );
    expect(codeOf(opened)).toBe('not-a-refusal');
    const { reviewId, revisionId } = detailOf(opened);
    const asked = await w.world.asAgent(
      { command: 'review.capture', operationId: randomUUID(), revisionId },
      delegation.credential,
    );
    expect(codeOf(asked)).toBe('not-a-refusal');

    const byAgent = {
      actor: w.world.agentActorId,
      person: w.ava.personId,
      delegation: delegation.id,
    };
    expect(byAgent.actor).not.toBe(w.ava.actorId);
    const asAgent = { actor: byAgent.actor, person: byAgent.person };
    expect(await writersOf(reviewId, revisionId)).toStrictEqual({
      review: [byAgent],
      revision: [byAgent],
      captures: [asAgent, asAgent],
    });
  });
});
