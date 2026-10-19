// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2013): a capture claim refused, faulted or never answered fails the pass the way an
// unread queue does: logged by code, no heartbeat, nothing fetched or landed. The first case
// is Sol's proof (S2147-2).

import { afterEach, expect, it, vi } from 'vitest';
import type { AgentCall, Answer } from '../../apps/site-runner/claims.ts';
import { passes, passFor } from '../../apps/site-runner/main.ts';
import { reviewCaptures } from '../../apps/site-runner/review-captures.ts';
import { AGENCY_POOL, PAGE, publicResolver, replay } from './c35-runner-world.ts';

afterEach(() => vi.restoreAllMocks());

/** One pass with one capture on the queue, its claim answered by `claim`. */
async function onePass(
  claim: () => Promise<Answer>,
): Promise<{ calls: readonly string[]; asked: readonly unknown[]; pings: number }> {
  const calls: string[] = [];
  const call: AgentCall = async (verb) => {
    calls.push(verb);
    if (verb === 'task.queue') {
      const queue = [{ taskId: 't1', reservationId: 'r1', purpose: 'review_capture' }];
      return await Promise.resolve({ detail: { queue } });
    }
    if (verb === 'task.pickup') {
      return await Promise.resolve({
        detail: { leaseId: 'l1', fence: 1, credential: 'test-only' },
      });
    }
    if (verb === 'review.capture_claim') return await claim();
    return await Promise.resolve({ detail: {} });
  };
  const transport = replay();
  const tx = {
    businessId: 'b1',
    query: async () => await Promise.resolve([{ revision_id: 'v1', page_url: PAGE }]),
  };
  const captures = reviewCaptures({
    call,
    db: {
      withBusiness: async (_: unknown, work: (tx: unknown) => Promise<unknown>) => await work(tx),
    } as never,
    business: 'b1' as never,
    capture: { pool: AGENCY_POOL, resolve: publicResolver, transport },
    browserAt: () => async () => await Promise.reject(new Error('must not open')),
  });
  const stopping = new AbortController();
  let pings = 0;
  await passes({
    pass: passFor(false, {
      locate: async () => await Promise.resolve([]),
      claims: async () => await Promise.resolve([]),
      captures,
    }),
    ping: async () => void (await Promise.resolve((pings += 1))),
    sleep: async () => void (await Promise.resolve(stopping.abort())),
    stopping: stopping.signal,
  });
  return { calls, asked: transport.asked, pings };
}

it('C35 a refused or faulted capture claim fails the pass without a heartbeat', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
  const pings: number[] = [];
  for (const answer of [{ refused: 'SCOPE_NOT_GRANTED' }, { fault: true }] as const) {
    // oxlint-disable-next-line no-await-in-loop -- one pass at a time
    const pass = await onePass(async () => await Promise.resolve(answer));
    expect(pass.calls).toContain('review.capture_claim');
    expect(pass.calls).not.toContain('review.capture_land');
    expect(pass.asked).toEqual([]);
    pings.push(pass.pings);
  }
  expect(logged.mock.calls.flat().join(' ')).toContain('SCOPE_NOT_GRANTED');
  expect(pings).toEqual([0, 0]);
});

it('C35 a capture claim that never answered fails the pass without a heartbeat', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
  const pass = await onePass(async () => await Promise.reject(new TypeError('fetch failed')));
  expect(pass.calls).not.toContain('review.capture_land');
  expect(pass.asked).toEqual([]);
  expect(logged.mock.calls.flat().join(' ')).toContain('CLAIM_FAULT');
  expect(pass.pings).toBe(0);
});
