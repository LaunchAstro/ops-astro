// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2013, TR-P-1): while the pool's reviews are open the runner captures the agency's own
// catalogued pages and nothing else. A review of a client's page, its capture approved and on
// the queue, is refused by the fence while no closed review is recorded (#2018): no request
// reaches the client's site, no browser opens, no picture is stored and no width lands, and the
// lease is handed back failed with the fence's code. The pool itself holds the configured site's pages only when that site is the
// business's own: a runner configured for a client's site captures none of them.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reviewPool } from '../../apps/site-runner/review-captures.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { B_FILE, B_PAGE, c35World, underReview, type C35World } from '../review/c35-world.ts';
import { capturesOf, storedObjects } from '../review/c35-landing.ts';
import { agentCalls, capturePass, PAGE, queueCapture, replay } from './c35-runner-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 client-site capture: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35runclient');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const BUSINESS = '6d1f0c55-5c4e-4d0b-9d4a-0f1e2d3c4b5a';
const site = (holder: string) => ({
  holder,
  repository: 'agency/site',
  defaultBranch: 'main',
  project: 'prj_agency',
  pages: [{ pageUrl: PAGE, path: 'src/pages/about.md' }],
});

describe('C35 the review capture pool', () => {
  it('holds the configured pages only when the site is the business’s own', () => {
    expect(reviewPool(site(BUSINESS), BUSINESS)).toStrictEqual({
      agencyPages: [PAGE],
      otherPages: [],
      closedPoolReviews: [],
    });
    const client = '0b7c2f6e-1d3a-4c5b-8e9f-a0b1c2d3e4f5';
    expect(reviewPool(site(client), BUSINESS)).toStrictEqual({
      agencyPages: [],
      otherPages: [],
      closedPoolReviews: [],
    });
  });
});

describe.skipIf(serverUrl === undefined)('C35 the runner and a client’s page', () => {
  it('C35 no client-site capture while pool reviews are open', async () => {
    const reviewed = await underReview(w, 'a client page under review', {
      partyId: w.partyB,
      pageUrl: B_PAGE,
      path: B_FILE,
    });
    await queueCapture(w, reviewed);
    const call = agentCalls(w);
    const transport = replay();
    const opened: number[] = [];
    const browserAt = (width: 1480 | 390) => {
      opened.push(width);
      return () => Promise.reject(new Error('no browser opens for a refused page'));
    };
    const stored = await storedObjects(w, w.world.business);

    const captured = await capturePass(w, { call, transport, browserAt });

    expect(captured).toStrictEqual([
      { taskId: reviewed.taskId, outcome: 'CAPTURE_POOL_REVIEWS_OPEN' },
    ]);
    expect(transport.asked).toStrictEqual([]);
    expect(opened).toStrictEqual([]);
    expect(call.sent.filter((one) => one.verb === 'review.capture_land')).toStrictEqual([]);
    expect(await storedObjects(w, w.world.business)).toBe(stored);
    const captures = await capturesOf(w, reviewed.revisionId);
    expect(captures.map((one) => one.state)).not.toContain('landed');
    const handback = call.sent.find((one) => one.verb === 'task.handback');
    expect(handback?.body).toMatchObject({
      outcome: 'failed',
      report: { capture: 'CAPTURE_POOL_REVIEWS_OPEN' },
    });
  }, 60_000);
});
