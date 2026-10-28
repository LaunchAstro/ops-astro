// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one planted world read across every crossing */
//
// The client's Reviews page (PROTO-GAPS row 7): a client reads only their own reviews, the
// client-marked pins and comments on them, their change requests and state, and the decision
// on the current revision. Planted markers prove what never arrives: an internal pin, a team
// comment and the team's change request text on their own review; a client pin on another
// client's review in the same business; and one on a review in another business. Another
// client's person reads only their own, and the team's reads stay closed to a client.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { grantTo, shareWithClient, type Member } from '../commands/fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { B_FILE, B_PAGE, spot } from './c35-world.ts';
import { c35xWorld, openedOf, type C35XWorld } from './c35-x-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('client reviews: DATABASE_URL is unset.');

const CLIENT_PIN = 'client-sees-pin-4a1c';
const CLIENT_COMMENT = 'client-sees-comment-e27d';
const INTERNAL_PIN = 'canary-internal-pin-91d2';
const TEAM_COMMENT = 'canary-team-comment-5b7e';
const REQUEST_TEXT = 'canary-request-text-0c3f';
const OTHER_CLIENT = 'canary-other-client-pin-77a0';
const OTHER_BUSINESS = 'canary-other-business-pin-c4e9';

let w: C35XWorld;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35xWorld('clientrev');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const listAs = async (member: Member, business = w.world.business) =>
  await executeRead(w.world.db.app, business, member.presented, {
    read: 'review.client_list',
  } as never);

/** A person outside the business who stands on one shared task and reads one client's reviews. */
async function clientOf(taskId: string, partyId: string | null): Promise<Member> {
  const person = await shareWithClient(w.world.db.app, w.world.business, w.admin, taskId);
  if (partyId === null) return person;
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    await grantTo(tx, person, 'read', { kind: 'party', id: partyId }, false, 'review');
  });
  return person;
}

const revisionOf = async (taskId: string): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly revision: string }>(
        'select revision::text as revision from public.records where business_id = $1 and id = $2',
        [w.world.business, taskId],
      )
    )[0]?.revision,
  );

const comment = async (taskId: string, body: string, audience: 'internal' | 'client') =>
  detailOf(
    await w.as(w.ava, {
      command: 'task.comment',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(taskId),
      body,
      audience,
    }),
  );

describe.skipIf(serverUrl === undefined)('the client Reviews read', () => {
  it('a client reads only its own reviews, in the client projection', async () => {
    // Client A's review: a client pin and comment, an internal pin, a team comment, a change
    // request from the client pin, and ben's approval of the current revision.
    const opened = openedOf(detailOf(await w.open(w.fay)));
    await w.capture(w.ava, opened.revisionId);
    const clientPin = String(
      detailOf(await w.pin(w.ava, opened.revisionId, { audience: 'client', body: CLIENT_PIN }))[
        'commentId'
      ],
    );
    await w.pin(w.ava, opened.revisionId, {
      body: INTERNAL_PIN,
      selector: [spot('xywh=10,10,20,20')],
    });
    await comment(w.taskA, TEAM_COMMENT, 'internal');
    await comment(w.taskA, CLIENT_COMMENT, 'client');
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, w.ava, 'write', { kind: 'business', id: null }, false, 'proposal');
    });
    const filed = await w.as(w.ava, {
      command: 'review.propose_change',
      operationId: randomUUID(),
      commentId: clientPin,
      text: `Move the heading ${REQUEST_TEXT}`,
    });
    const changeRequestId = String(detailOf(filed)['changeRequestId']);
    expect(codeOf(await w.decide(w.ben, opened))).toBe('not-a-refusal');

    // Client B's review in the same business, with a client pin of its own.
    const b = openedOf(
      detailOf(await w.open(w.ava, { taskId: w.taskB, pageUrl: B_PAGE, path: B_FILE })),
    );
    await w.capture(w.ava, b.revisionId);
    await w.pin(w.ava, b.revisionId, { audience: 'client', body: OTHER_CLIENT });
    // A review in beta, with a client pin of its own.
    const beta = openedOf(detailOf(await w.open(w.eve, { taskId: w.betaTask }, w.beta)));
    await w.capture(w.eve, beta.revisionId, w.beta);
    await w.pin(w.eve, beta.revisionId, { audience: 'client', body: OTHER_BUSINESS }, w.beta);

    const clientA = await clientOf(w.taskA, w.partyA);
    const read = await listAs(clientA);
    expect(codeOf(read as never)).toBe('not-a-refusal');
    const reviews = (read as unknown as { readonly reviews: readonly Record<string, unknown>[] })
      .reviews;
    expect(reviews.map((review) => review['reviewId'])).toStrictEqual([opened.reviewId]);
    expect(reviews[0]).toMatchObject({
      revision: 1,
      approved: { decidedAt: expect.any(String) },
      changeRequests: [{ changeRequestId, commentId: clientPin, state: 'proposed' }],
    });
    const said = JSON.stringify(read);
    expect(said).toContain(CLIENT_PIN);
    expect(said).toContain(CLIENT_COMMENT);
    for (const planted of [INTERNAL_PIN, TEAM_COMMENT, REQUEST_TEXT, OTHER_CLIENT, OTHER_BUSINESS])
      expect(said).not.toContain(planted);
    for (const foreign of [b.reviewId, beta.reviewId, w.ben.personId])
      expect(said).not.toContain(foreign);

    // Another client's person in the same business reads only their own review.
    const clientB = await clientOf(w.taskB, w.partyB);
    const theirs = JSON.stringify(await listAs(clientB));
    expect(theirs).toContain(OTHER_CLIENT);
    expect(theirs).toContain(b.reviewId);
    for (const planted of [CLIENT_PIN, CLIENT_COMMENT, opened.reviewId, OTHER_BUSINESS])
      expect(theirs).not.toContain(planted);

    // Client A asking in beta, and a shared client holding no review grant: nothing.
    const crossed = await listAs(clientA, w.beta);
    expect(codeOf(crossed as never)).not.toBe('not-a-refusal');
    const ungranted = await listAs(await clientOf(w.taskA, null));
    expect(codeOf(ungranted as never)).toBe('SCOPE_NOT_GRANTED');
    for (const answer of [crossed, ungranted]) {
      const words = JSON.stringify(answer);
      for (const planted of [CLIENT_PIN, OTHER_BUSINESS, opened.reviewId, beta.reviewId])
        expect(words).not.toContain(planted);
    }

    // The team's reads stay the team's: the review and its picture answer the client nothing.
    const team = await executeRead(w.world.db.app, w.world.business, clientA.presented, {
      read: 'review.read',
      reviewId: opened.reviewId,
    } as never);
    expect(codeOf(team as never)).toBe('NOT_FOUND');
  });
});
