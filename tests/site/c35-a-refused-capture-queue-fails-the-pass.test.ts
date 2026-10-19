// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2013): the review captures read the queue as the corrections do (#2005), and a queue
// they cannot read fails the pass the same way, whatever the locate and the corrections did.
// The host's own pass (`passFor`: the locate, the corrections, then the captures) under the
// pass loop (`passes`), with the real capture job and no database: a `task.queue` refused, or
// with no usable answer, logs one fixed line by code, picks nothing up, lands nothing and pings
// no heartbeat. A capture queue with nothing on it still passes and pings.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCall, Answer } from '../../apps/site-runner/claims.ts';
import { passes, passFor } from '../../apps/site-runner/main.ts';
import { reviewCaptures } from '../../apps/site-runner/review-captures.ts';
import { AGENCY_POOL, publicResolver, replay } from './c35-runner-world.ts';

const PASSWORD = 'fixture-canary-password-6c21d8';

afterEach(() => {
  vi.restoreAllMocks();
});

/** One pass with the corrections' queue empty and the captures' queue answering `queue`. */
async function onePass(
  queue: Answer | Error,
): Promise<{ printed: string; pings: number; asked: readonly string[] }> {
  const asked: string[] = [];
  const call: AgentCall = async (verb) => {
    asked.push(verb);
    if (verb !== 'task.queue') return { fault: true };
    if (queue instanceof Error) throw queue;
    return await Promise.resolve(queue);
  };
  const captures = reviewCaptures({
    call,
    db: undefined as never,
    business: undefined as never,
    capture: { pool: AGENCY_POOL, resolve: publicResolver, transport: replay() },
    browserAt: () => () => Promise.reject(new Error('no capture is taken')),
  });
  const printed: string[] = [];
  const keep = (...line: unknown[]) => void printed.push(`${line.join(' ')}\n`);
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
  let pings = 0;
  const stopping = new AbortController();
  await passes({
    pass: passFor(false, {
      locate: async () => await Promise.resolve([{ correctionId: 'c1', outcome: 'located' }]),
      claims: async () => await Promise.resolve([{ correctionId: 'c2', outcome: 'live' }]),
      captures,
    }),
    ping: async () => void (await Promise.resolve((pings += 1))),
    sleep: async () => void (await Promise.resolve(stopping.abort())),
    stopping: stopping.signal,
  });
  return { printed: printed.join(''), pings, asked };
}

describe('C35 the review captures, a queue they cannot read', () => {
  it('C35 a refused capture queue fails the pass', async () => {
    expect(await onePass({ refused: 'SCOPE_NOT_GRANTED' })).toEqual({
      printed: 'site-runner: the queue was refused: SCOPE_NOT_GRANTED\n',
      pings: 0,
      asked: ['task.queue'],
    });
  });

  it('a refusal whose code is not a code prints none of it', async () => {
    expect(await onePass({ refused: `rejected ${PASSWORD}` })).toEqual({
      printed: 'site-runner: the queue was refused: unreadable\n',
      pings: 0,
      asked: ['task.queue'],
    });
  });

  it('a faulted or unanswered capture queue fails the pass as a fault', async () => {
    for (const queue of [
      { fault: true } as const,
      { detail: { queue: null } },
      new TypeError(`fetch failed for ${PASSWORD}`),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one pass at a time
      expect(await onePass(queue)).toEqual({
        printed: 'site-runner: a pass failed: QueueFault\n',
        pings: 0,
        asked: ['task.queue'],
      });
    }
  });

  it('an empty capture queue passes and pings', async () => {
    expect(await onePass({ detail: { queue: [] } })).toEqual({
      printed: 'c1 located\nc2 live\n',
      pings: 1,
      asked: ['task.queue'],
    });
  });
});
