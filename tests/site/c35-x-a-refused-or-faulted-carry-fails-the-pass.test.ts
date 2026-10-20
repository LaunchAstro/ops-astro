// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X (#2166): a carry the land said was due, refused, faulted or never answered, fails the
// pass the way an unclaimed capture does: logged by its code, the lease handed back failed
// with that code, and no heartbeat.

import { afterEach, expect, it, vi } from 'vitest';
import type { AgentCall, Answer } from '../../apps/site-runner/claims.ts';
import { passes, passFor } from '../../apps/site-runner/main.ts';
import { reviewCaptures, type SizedBrowser } from '../../apps/site-runner/review-captures.ts';
import { AGENCY_POOL, PAGE, publicResolver, replay, SHEET } from './c35-runner-world.ts';

afterEach(() => vi.restoreAllMocks());

/** A browser that asks for the page and its stylesheet through the fence's route, as one does. */
const routedAt: SizedBrowser = () => async (url, route) => {
  await route({ url, kind: 'document', mainFrame: true });
  const answer = await route({ url: SHEET, kind: 'stylesheet', mainFrame: false });
  const copy = /^@import "([^"]*)";/u.exec(answer?.body ?? '')?.[1];
  if (copy !== undefined) await route({ url: copy, kind: 'stylesheet', mainFrame: false });
  return new Uint8Array([137, 80, 78, 71]);
};

/** The runner's agent calls, recorded: one capture queued, its lands answering carryDue. */
function answering(carry: () => Promise<Answer>): AgentCall & {
  readonly calls: { readonly verb: string; readonly body: unknown }[];
} {
  const calls: { verb: string; body: unknown }[] = [];
  const call: AgentCall = async (verb, body) => {
    calls.push({ verb, body });
    if (verb === 'task.queue') {
      const queue = [{ taskId: 't1', reservationId: 'r1', purpose: 'review_capture' }];
      return await Promise.resolve({ detail: { queue } });
    }
    if (verb === 'task.pickup') {
      return await Promise.resolve({
        detail: { leaseId: 'l1', fence: 1, credential: 'test-only' },
      });
    }
    if (verb === 'review.capture_claim') {
      return await Promise.resolve({ detail: { widths: [1480, 390] } });
    }
    if (verb === 'review.capture_land') {
      return await Promise.resolve({ detail: { carryDue: body['width'] === 390 } });
    }
    if (verb === 'review.carry_pins') return await carry();
    return await Promise.resolve({ detail: {} });
  };
  return Object.assign(call, { calls });
}

/** One pass with one capture on the queue whose lands answer carryDue, its carry by `carry`. */
async function onePass(carry: () => Promise<Answer>): Promise<{
  readonly calls: readonly { readonly verb: string; readonly body: unknown }[];
  readonly pings: number;
}> {
  const call = answering(carry);
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
    capture: { pool: AGENCY_POOL, resolve: publicResolver, transport: replay() },
    browserAt: routedAt,
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
  return { calls: call.calls, pings };
}

it('C35-X a refused, faulted or unanswered carry fails the pass without a heartbeat', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
  const ends = [
    [async () => await Promise.resolve({ refused: 'LEASE_EXPIRED' }), 'LEASE_EXPIRED'],
    [async () => await Promise.resolve({ fault: true } as const), 'CARRY_FAULT'],
    [async () => await Promise.reject(new TypeError('fetch failed')), 'CARRY_FAULT'],
  ] as const;
  for (const [carry, code] of ends) {
    logged.mockClear();
    // oxlint-disable-next-line no-await-in-loop -- one pass at a time
    const pass = await onePass(carry);
    const verbs = pass.calls.map((one) => one.verb);
    expect(verbs.slice(verbs.indexOf('review.capture_land'))).toStrictEqual([
      'review.capture_land',
      'review.capture_land',
      'review.carry_pins',
      'task.handback',
    ]);
    expect(pass.calls.find((one) => one.verb === 'review.carry_pins')?.body).toStrictEqual({
      leaseId: 'l1',
      fence: 1,
      revisionId: 'v1',
    });
    expect(pass.calls.find((one) => one.verb === 'task.handback')?.body).toMatchObject({
      outcome: 'failed',
      report: { capture: code },
    });
    expect(logged.mock.calls.flat().join(' ')).toContain(`review capture t1 ${code}`);
    expect(pass.pings).toBe(0);
  }
});
