// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner's pass loop (`apps/site-runner/main.ts`, `passes`) over the
// host's own pass (`passFor`: the locate, then the claims) with the real runner
// and its real queue claims, and no database: a `task.queue` the API refused,
// or one with no usable answer, fails the pass (#2005), whatever the locate
// did. It logs one fixed line, takes nothing off the queue and pings no
// heartbeat, so the operator's watcher mails. An empty queue still passes
// quietly and pings, and a failed locate alone still leaves the pass standing.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { queueClaims, type AgentCall, type Answer } from '../../apps/site-runner/claims.ts';
import { passes, passFor } from '../../apps/site-runner/main.ts';
import type { Passed as Settled } from '../../apps/site-runner/runner.ts';
import { createSiteRunner } from '../../apps/site-runner/runner.ts';

const PASSWORD = 'fixture-canary-password-3b9e41';

/** A locate that settled one correction, and one whose database went away. */
const settledOne = async (): Promise<readonly Settled[]> =>
  await Promise.resolve([{ correctionId: 'c1', outcome: 'located' }]);
const locateFails = async (): Promise<readonly Settled[]> =>
  await Promise.reject(new RangeError('the database went away'));

afterEach(() => {
  vi.restoreAllMocks();
});

interface Passed {
  readonly printed: string;
  readonly pings: number;
  readonly asked: readonly string[];
}

/**
 * One pass of the loop with `task.queue` answering `queue` (a rejection when
 * it is an error) and the locate settling `located`: what it printed, pinged
 * and asked.
 */
async function onePass(
  queue: Answer | Error,
  located: () => Promise<readonly Settled[]> = async () => await Promise.resolve([]),
): Promise<Passed> {
  const asked: string[] = [];
  const call: AgentCall = async (verb) => {
    asked.push(verb);
    if (verb !== 'task.queue') return { fault: true };
    if (queue instanceof Error) throw queue;
    return await Promise.resolve(queue);
  };
  // An empty, refused or faulted queue reads nothing else, so nothing else is wired.
  const claims = queueClaims(call, undefined as never, undefined as never);
  const runner = createSiteRunner({ claims, actorId: '' } as never);
  const printed: string[] = [];
  const keep = (...line: unknown[]) => void printed.push(`${line.join(' ')}\n`);
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
  let pings = 0;
  const stopping = new AbortController();
  await passes({
    pass: passFor(false, { locate: located, claims: async () => await runner.pass() }),
    ping: async () => void (await Promise.resolve((pings += 1))),
    sleep: async () => void (await Promise.resolve(stopping.abort())),
    stopping: stopping.signal,
  });
  return { printed: printed.join(''), pings, asked };
}

describe('the site runner, a queue it cannot read', () => {
  it('a refused queue logs its code alone, takes nothing and pings no heartbeat', async () => {
    for (const code of ['SCOPE_NOT_GRANTED', 'AUTH_SESSION_EXPIRED']) {
      // oxlint-disable-next-line no-await-in-loop -- one pass at a time
      expect(await onePass({ refused: code })).toEqual({
        printed: `site-runner: the queue was refused: ${code}\n`,
        pings: 0,
        asked: ['task.queue'],
      });
    }
  });

  it('a refusal whose code is not a code prints none of it', async () => {
    const passed = await onePass({ refused: `rejected ${PASSWORD}` });
    expect(passed).toEqual({
      printed: 'site-runner: the queue was refused: unreadable\n',
      pings: 0,
      asked: ['task.queue'],
    });
  });

  it('a faulted queue fails the pass, takes nothing and pings no heartbeat', async () => {
    expect(await onePass({ fault: true })).toEqual({
      printed: 'site-runner: a pass failed: QueueFault\n',
      pings: 0,
      asked: ['task.queue'],
    });
  });

  it('a queue answered with no list of work fails the pass as a fault', async () => {
    for (const detail of [{}, { queue: null }, { queue: { reservationId: 'r1' } }]) {
      // oxlint-disable-next-line no-await-in-loop -- one pass at a time
      expect(await onePass({ detail })).toEqual({
        printed: 'site-runner: a pass failed: QueueFault\n',
        pings: 0,
        asked: ['task.queue'],
      });
    }
  });
});

describe('the site runner, a queue it cannot read beside the locate', () => {
  it('a queue call that never answered fails the pass as a fault', async () => {
    expect(await onePass(new TypeError(`fetch failed for ${PASSWORD}`))).toEqual({
      printed: 'site-runner: a pass failed: QueueFault\n',
      pings: 0,
      asked: ['task.queue'],
    });
  });

  it('a refused queue fails the pass even when the locate settled work', async () => {
    expect(await onePass({ refused: 'SCOPE_NOT_GRANTED' }, settledOne)).toEqual({
      printed: 'site-runner: the queue was refused: SCOPE_NOT_GRANTED\n',
      pings: 0,
      asked: ['task.queue'],
    });
  });

  it('a failed locate with an empty queue still passes and pings', async () => {
    expect(await onePass({ detail: { queue: [] } }, locateFails)).toEqual({
      printed: 'site-runner: the locate failed: RangeError\n',
      pings: 1,
      asked: ['task.queue'],
    });
  });

  it('an empty queue passes quietly and pings', async () => {
    expect(await onePass({ detail: { queue: [] } })).toEqual({
      printed: '',
      pings: 1,
      asked: ['task.queue'],
    });
  });
});
