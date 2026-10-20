// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2018, D17-14): a closed other-company adversarial review of the capture pool is
// recorded by one command, `operations.record_capture_pool_review`, a person's under
// `operations:manage` in the business that operates the installation, under the
// installation's row lock, audited by the envelope. Another business's holder of that
// grant, a holder scoped to one client, a person without it and an agent are each refused
// and write nothing, and no refusal names the review a planted record holds. The
// application's role may add a review and read only its identity and pool version: it
// changes and removes nothing, and never reads the evidence or the reviewer back.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAPTURE_POOL_VERSION } from '../../packages/core-connectors/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c35World, pickUpReviewed, underReview, type C35World } from './c35-world.ts';
import {
  codeOf,
  directAsApp,
  poolDigest,
  poolOperators,
  poolReview,
  RECORD,
  recordedAndAudited,
  refusedCrossings,
  uniqueReview,
  type Crossing,
} from './c35-pool-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 pool review record: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c35World('c35poolrec');
  await poolOperators(w);
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

/** The agent's call under a live pickup's delegation, as a crossing. */
async function agentCrossing(review: string): Promise<Crossing> {
  const lease = await pickUpReviewed(w, await underReview(w, 'a lease for the agent'));
  return [
    "an agent on ava's behalf",
    async () =>
      await w.world.asAgent({ operationId: randomUUID(), ...poolReview(review) }, lease.credential),
    'DELEGATION_EXCLUDES_OPERATION',
  ];
}

const onDatabase = describe.skipIf(serverUrl === undefined);

onDatabase('C35 who may record a capture pool review', () => {
  it("C35 another business's operations:manage holder cannot record a pool review", async () => {
    const eve = async () => await w.asIn(w.beta, w.eve, poolReview(uniqueReview('beta')));
    expect(
      await refusedCrossings(w, [['another business', eve, 'SCOPE_NOT_GRANTED']]),
    ).toStrictEqual([]);
  });

  it('C35 an agent cannot record a pool review', async () => {
    const bare = async () =>
      await w.world.asAgent({ operationId: randomUUID(), ...poolReview(uniqueReview('bare')) });
    const before = await poolDigest(w);
    expect(codeOf(await bare())).not.toBe('applied');
    expect(await poolDigest(w)).toBe(before);
    expect(await refusedCrossings(w, [await agentCrossing(uniqueReview('agent'))])).toStrictEqual(
      [],
    );
  });
});

onDatabase('C35 a recorded pool review is audited', () => {
  it('C35 audit readback', async () => {
    const review = uniqueReview('audited');
    const operationId = randomUUID();

    expect(codeOf(await w.as(w.ava, { operationId, ...poolReview(review) }))).toBe('applied');

    const { rows, audited, whole } = await recordedAndAudited(w, review, operationId);
    // The driver's rows are not plain objects: compared by value.
    expect(rows).toEqual([
      {
        review,
        pool_version: CAPTURE_POOL_VERSION,
        status: 'closed',
        evidence: `https://reviews.example/pool/${review}`,
        company: 'Other Company Pty Ltd',
        business: w.world.business,
        person: w.ava.personId,
        actor: w.ava.actorId,
        operation: operationId,
      },
    ]);
    expect(audited).toEqual([
      { business: w.world.business, actor: w.ava.actorId, command: RECORD, outcome: 'applied' },
    ]);
    // The request is kept as its digest: no evidence link and no reviewer in the chain.
    expect(whole).not.toContain('reviews.example');
    expect(whole).not.toContain('Other Company');
  });
});

onDatabase('C35 pool reviews across businesses, clients and people', () => {
  it('C35 isolation', async () => {
    const marker = uniqueReview('marker');
    expect(codeOf(await w.as(w.ava, poolReview(marker)))).toBe('applied');
    const crossings: Crossing[] = [
      [
        'another business',
        async () => await w.asIn(w.beta, w.eve, poolReview(marker)),
        'SCOPE_NOT_GRANTED',
      ],
      [
        'a holder scoped to one client',
        async () => await w.as(w.dee, poolReview(marker)),
        'SCOPE_NOT_GRANTED',
      ],
      [
        'another person',
        async () => await w.as(w.cal, poolReview(uniqueReview('cal'))),
        'SCOPE_NOT_GRANTED',
      ],
      await agentCrossing(marker),
    ];

    expect(await refusedCrossings(w, crossings)).toStrictEqual([]);
    const denied = await directAsApp(w);
    expect(denied.filter((line) => !line.endsWith(': denied'))).toStrictEqual([]);
    // The identity is the installation's, read alike from any business: no business's data.
    const visible = await w.world.db.app.withBusiness(
      w.beta,
      async (tx) =>
        await tx.query('select review from ops.capture_pool_reviews where review = $1', [marker]),
    );
    expect(visible).toEqual([{ review: marker }]);
  });
});

onDatabase('C35 one row per review', () => {
  it('C35 blank, padded, cased or repeated review identities never count twice', async () => {
    const review = uniqueReview('once');
    const before = await poolDigest(w);
    const invalid = [
      poolReview(''),
      poolReview(` ${review}`),
      poolReview(review.toUpperCase()),
      poolReview(review, { poolVersion: 'fence-0' }),
      poolReview(review, { evidence: 'https://a:b@example.com/x' }),
      poolReview(review, { evidence: 'http://reviews.example/x' }),
      poolReview(review, { company: ' ' }),
    ];
    const answered = await Promise.all(invalid.map(async (body) => await w.as(w.ava, body)));
    expect(answered.map((one) => codeOf(one))).toStrictEqual(
      invalid.map(() => 'FIELD_VALUE_INVALID'),
    );
    expect(await poolDigest(w)).toBe(before);

    // The same review sent twice at once: one row, and the other told it is already recorded.
    const both = await Promise.all([
      w.as(w.ava, poolReview(review)),
      w.as(w.ava, poolReview(review)),
    ]);
    expect(both.map((one) => codeOf(one)).toSorted()).toStrictEqual([
      'POOL_REVIEW_ALREADY_RECORDED',
      'applied',
    ]);
    const [counted] = await w.world.db.admin.execute<{ n: string }>(
      'select count(*)::text as n from ops.capture_pool_reviews where review = $1',
      [review],
    );
    expect(counted?.n).toBe('1');
  });
});
