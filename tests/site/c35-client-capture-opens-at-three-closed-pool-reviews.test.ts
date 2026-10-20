// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2018, TR-P-1): the runner's capture pool comes from the rows. For a review of a
// client's page it reads the page, if the client's site still binds it, and the installation's
// closed reviews of the pool the fence runs now. While fewer than three are recorded the fence
// refuses the page and nothing reaches the client's site; at three distinct closed reviews the
// page is captured and lands at both widths. Reviews of another pool version never count, a
// pool read that fails fails the pass with nothing fetched, and a runner started afresh reads
// the same rows: no list is kept in memory or taken from its settings.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PictureBrowser, TransportAnswer } from '../../packages/core-connectors/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { B_FILE, B_PAGE, c35World, underReview, type C35World } from '../review/c35-world.ts';
import { capturesOf, pictureBytes } from '../review/c35-landing.ts';
import { poolOperators, poolReview } from '../review/c35-pool-world.ts';
import { CSS, PAGE as PAGE_HTML } from './c80-picture-world.ts';
import { agentCalls, capturePass, queueCapture, replay } from './c35-runner-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C35 pool reviews and the runner: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c35World('c35poolrun');
  await poolOperators(w);
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const B_SHEET = new URL('/_astro/site.css', B_PAGE).href;
const answer = (type: string, body: string): TransportAnswer => ({
  kind: 'answer',
  status: 200,
  headers: { 'content-type': type },
  body: new TextEncoder().encode(body),
});
/** Party B's team page and its stylesheet, as the replay serves them. */
const CLIENT_SITE = {
  [B_PAGE]: answer('text/html; charset=utf-8', PAGE_HTML),
  [B_SHEET]: answer('text/css', CSS),
};

/**
 * A browser that asks for the page, its stylesheet and the copy that sheet's answer imports
 * through the fence, as a browser does, then renders.
 */
const rendering = (opened: number[]) => (width: 1480 | 390) => {
  opened.push(width);
  const browser: PictureBrowser = async (url, route) => {
    await route({ url, kind: 'document', mainFrame: true });
    const sheet = new URL('/_astro/site.css', url).href;
    const sheetAnswer = await route({ url: sheet, kind: 'stylesheet', mainFrame: false });
    const copy = /^@import "([^"]*)";/u.exec(sheetAnswer?.body ?? '')?.[1];
    if (copy !== undefined) await route({ url: copy, kind: 'stylesheet', mainFrame: false });
    return pictureBytes(width);
  };
  return browser;
};

/** A review of party B's bound team page, its capture approved and on the queue. */
async function clientPageQueued(title: string) {
  const reviewed = await underReview(w, title, {
    partyId: w.partyB,
    pageUrl: B_PAGE,
    path: B_FILE,
  });
  await queueCapture(w, reviewed);
  return reviewed;
}

/** One capture pass on the client's replayed site: what it captured, asked and handed back. */
async function clientPass(db?: Database) {
  const call = agentCalls(w);
  const transport = replay(CLIENT_SITE);
  const opened: number[] = [];
  const captured = await capturePass(w, {
    call,
    transport,
    browserAt: rendering(opened),
    ...(db === undefined ? {} : { db }),
  }).catch((fault: unknown) => fault);
  const handback = call.sent.find((one) => one.verb === 'task.handback')?.body;
  return { captured, asked: transport.asked.map((one) => one.url.href), opened, handback };
}

const record = async (review: string): Promise<void> => {
  const answered = await w.as(w.ava, poolReview(review));
  if (isCommandRefusal(answered))
    throw new Error(`recording ${review} was refused ${answered.code}`);
};

/** The app's own login, with every read of the pool's reviews refused. */
const poolUnreadable = (): Database => {
  const app = w.world.db.app;
  return {
    ...app,
    withBusiness: async (business: string, work: (tx: never) => Promise<unknown>) =>
      await app.withBusiness(business as never, async (tx) => {
        const query = async (sql: string, params?: unknown[]) =>
          /capture_pool_reviews/u.test(sql)
            ? await Promise.reject(new Error('permission denied for table capture_pool_reviews'))
            : await tx.query(sql, params);
        return await work(
          new Proxy(tx, {
            get: (t, key) => (key === 'query' ? query : Reflect.get(t, key)),
          }) as never,
        );
      }),
  } as unknown as Database;
};

const onDatabase = describe.skipIf(serverUrl === undefined);

onDatabase('C35 the runner’s capture pool', () => {
  it('C35 the runner reads the pool from the rows', async () => {
    // Three closed reviews of another pool version: none of them counts.
    for (const n of [1, 2, 3]) {
      // oxlint-disable-next-line no-await-in-loop
      await w.world.db.admin.execute(
        `insert into ops.capture_pool_reviews (review, pool_version, evidence, company,
           operator_business_id, recorded_by_person_id, recorded_by_actor_id, operation_id)
         values ($1, 'fence-0', $2, 'Other Company Pty Ltd', $3, $4, $5, $6)`,
        [
          `stale-${String(n)}`,
          `https://reviews.example/stale/${String(n)}`,
          w.world.business,
          w.ava.personId,
          w.ava.actorId,
          randomUUID(),
        ],
      );
    }
    const stale = await clientPageQueued('reviews of another pool version');
    const refused = await clientPass();
    expect(refused.captured).toStrictEqual([
      { taskId: stale.taskId, outcome: 'CAPTURE_POOL_REVIEWS_OPEN' },
    ]);
    expect(refused.asked).toStrictEqual([]);

    // A pool read that fails fails the pass: nothing fetched, the lease handed back failed.
    const unread = await clientPageQueued('a pool that cannot be read');
    const failed = await clientPass(poolUnreadable());
    expect(failed.captured).toBeInstanceOf(Error);
    expect((failed.captured as Error).name).toBe('PoolUnread');
    expect(failed.asked).toStrictEqual([]);
    expect(failed.opened).toStrictEqual([]);
    expect(failed.handback).toMatchObject({
      outcome: 'failed',
      report: { capture: 'POOL_UNREAD' },
    });
    expect((await capturesOf(w, unread.revisionId)).map((one) => one.state)).not.toContain(
      'landed',
    );
  }, 120_000);
});

onDatabase('C35 a client’s page and the pool’s reviews', () => {
  it('C35 no client-site capture while pool reviews are open', async () => {
    await record('first-review');
    await record('second-review');
    const twoClosed = await clientPageQueued('two closed reviews');

    const held = await clientPass();

    expect(held.captured).toStrictEqual([
      { taskId: twoClosed.taskId, outcome: 'CAPTURE_POOL_REVIEWS_OPEN' },
    ]);
    expect(held.asked).toStrictEqual([]);
    expect(held.opened).toStrictEqual([]);
    expect(held.handback).toMatchObject({
      outcome: 'failed',
      report: { capture: 'CAPTURE_POOL_REVIEWS_OPEN' },
    });

    await record('third-review');
    const threeClosed = await clientPageQueued('three closed reviews');

    const admitted = await clientPass();

    expect(admitted.captured).toStrictEqual([{ taskId: threeClosed.taskId, outcome: 'landed' }]);
    expect(admitted.asked).toContain(B_PAGE);
    expect(admitted.asked.every((url) => new URL(url).host === 'client-b.example')).toBe(true);
    const landed = await capturesOf(w, threeClosed.revisionId);
    expect(landed.map((one) => one.state).toSorted()).toStrictEqual(['landed', 'landed']);

    // A runner started afresh reads the same rows: the next review's capture lands too.
    const afterRestart = await clientPageQueued('after a restart');
    const again = await clientPass();
    expect(again.captured).toStrictEqual([{ taskId: afterRestart.taskId, outcome: 'landed' }]);
  }, 180_000);
});
