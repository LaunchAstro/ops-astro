// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2013): the site runner takes a person's approved `review_capture` step off the real
// queue, claims the review's captures under its own lease, takes both pictures in the
// production browser (headless Chromium at 1480 and 390, its own network off) and the page
// observation through the fence, and lands them through the API. `review.read` then shows
// both widths landed with the observation of the replayed page, and `review.picture` hands
// back PNGs of those widths. The replay site saw only the page and its stylesheet: the
// page's host resolves nowhere, so the picture loaded through the fence's route or not at
// all. No Chromium is no skip: the capture fails and so does this proof.

import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromiumAt } from '../../apps/site-runner/picture-browser.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c35World, underReview, type C35World } from '../review/c35-world.ts';
import { readPicture } from '../review/c35-landing.ts';
import { PAGE as PAGE_HTML } from './c80-picture-world.ts';
import {
  agentCalls,
  capturePass,
  leaseOn,
  PAGE,
  queueCapture,
  replay,
  SHEET,
} from './c35-runner-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 runner capture: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35runcap');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const sha256 = (text: string): string =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;

/** Each landed picture, read back by its id, is a PNG of its capture's width. */
async function expectPngsOfTheirWidths(
  captures: readonly { readonly width: number; readonly pictureId: unknown }[],
): Promise<void> {
  for (const capture of captures) {
    // oxlint-disable-next-line no-await-in-loop -- one picture at a time
    const picture = await readPicture(w, w.ava, capture.pictureId);
    if (isCommandRefusal(picture) || !('picture' in picture)) {
      throw new Error(`review.picture answered ${JSON.stringify(picture)}`);
    }
    expect(PNG.sync.read(Buffer.from(picture.picture.body, 'base64')).width).toBe(capture.width);
  }
}

describe.skipIf(serverUrl === undefined)('C35 the site runner captures a review', () => {
  it('C35 the runner captures at 1480 and 390 through the fence', async () => {
    const reviewed = await underReview(w, 'the runner captures the about page');
    await queueCapture(w, reviewed);
    const call = agentCalls(w);
    const transport = replay();

    const captured = await capturePass(w, { call, transport, browserAt: chromiumAt });

    expect(captured).toStrictEqual([{ taskId: reviewed.taskId, outcome: 'landed' }]);
    // Under the runner's own lease, handed back once both widths landed.
    const lease = await leaseOn(w, reviewed.taskId);
    expect(lease?.holder).toBe(w.world.agentActorId);
    expect(lease?.state).not.toBe('live');
    const lands = call.sent.filter((one) => one.verb === 'review.capture_land');
    expect(lands.map((one) => [one.body['width'], one.body['leaseId']])).toStrictEqual([
      [1480, lease?.id],
      [390, lease?.id],
    ]);

    const read = await w.read(w.ava, reviewed.reviewId);
    if (isCommandRefusal(read) || !('review' in read)) {
      throw new Error(`review.read answered ${JSON.stringify(read)}`);
    }
    const revision = read.review.revisions.find((one) => one.revisionId === reviewed.revisionId);
    const observation = {
      url: PAGE,
      status: 200,
      documentDigest: sha256(PAGE_HTML),
      stylesheets: { [SHEET]: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) as unknown },
    };
    expect(revision?.captures).toMatchObject([
      { width: 1480, state: 'landed', observation },
      { width: 390, state: 'landed', observation },
    ]);

    await expectPngsOfTheirWidths(revision?.captures ?? []);

    // Only the fence fetched anything: the page and its stylesheet, nothing else.
    expect(new Set(transport.asked.map((request) => request.url.href))).toStrictEqual(
      new Set([PAGE, SHEET]),
    );
  }, 90_000);
});
