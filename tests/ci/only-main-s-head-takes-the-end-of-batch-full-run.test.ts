// SPDX-License-Identifier: AGPL-3.0-only
//
// The end of a batch (#1485, design checked 18 October 2026): a push whose tree a green merge group
// tested decides against main's head as well as the queue. Superseded, it is light: a later push
// owns the batch end. Still the head, it waits until main moves (light) or the queue empties
// (full), so a group that fails after the last push still leaves main's tip a full run (#1533).
// Anything unread, or the wait's cap, is full.

import { describe, expect, it } from 'vitest';
import { batchEnd, FULL, LIGHT } from '../../scripts/full-run.ts';

const REPO = 'LaunchAstro/ops-astro';
const SHA = '1'.repeat(40);
const LATER = '2'.repeat(40);
const pause = () => Promise.resolve();

/**
 * A repository whose main head and queue count are read in turn from `heads` and `counts`, the
 * last of each for good: one entry a read, as the queue and main change while a push waits.
 */
function world(heads: (string | Error)[], counts: number[]) {
  let headRead = 0;
  let queueRead = 0;
  const api = (path: string): Promise<unknown> => {
    if (!path.endsWith('/commits/main')) return Promise.reject(new Error(`GET ${path}: 404`));
    const head = heads[Math.min(headRead++, heads.length - 1)];
    return head instanceof Error ? Promise.reject(head) : Promise.resolve({ sha: head });
  };
  const graphql = () => {
    const count = counts[Math.min(queueRead++, counts.length - 1)];
    return Promise.resolve({
      data: { repository: { mergeQueue: { entries: { totalCount: count } } } },
    });
  };
  return { api, graphql, reads: () => ({ heads: headRead, queues: queueRead }) };
}

describe('the end of a batch', () => {
  it('is light for a push main has moved past, whatever the queue holds', async () => {
    const scopes = await Promise.all(
      [0, 2].map(async (count) => {
        const { api, graphql } = world([LATER], [count]);
        return await batchEnd({ api, graphql, repo: REPO, sha: SHA, pause });
      }),
    );
    expect(scopes).toStrictEqual([LIGHT, LIGHT]);
  });

  it('is full for main’s head once the queue is empty', async () => {
    const { api, graphql } = world([SHA], [0]);
    expect(await batchEnd({ api, graphql, repo: REPO, sha: SHA, pause })).toBe(FULL);
  });

  it('is full for main’s head when the queue empties after a group fails, main unchanged', async () => {
    // The last push saw two groups queued; both failed, so no push follows and the queue drains.
    const { api, graphql, reads } = world([SHA], [2, 1, 0]);
    expect(await batchEnd({ api, graphql, repo: REPO, sha: SHA, pause })).toBe(FULL);
    expect(reads().queues).toBe(3);
  });

  it('is light for main’s head when main moves on while it waits', async () => {
    const { api, graphql } = world([SHA, SHA, LATER], [2]);
    expect(await batchEnd({ api, graphql, repo: REPO, sha: SHA, pause })).toBe(LIGHT);
  });

  it('is full at the wait’s cap, the queue still busy and main unchanged', async () => {
    const { api, graphql, reads } = world([SHA], [3]);
    expect(await batchEnd({ api, graphql, repo: REPO, sha: SHA, pause, waits: 4 })).toBe(FULL);
    expect(reads().queues).toBe(5);
  });

  it('is full when main’s head cannot be read', async () => {
    const { api, graphql } = world([new Error('GET /commits/main: 502')], [2]);
    expect(await batchEnd({ api, graphql, repo: REPO, sha: SHA, pause })).toBe(FULL);
  });
});
