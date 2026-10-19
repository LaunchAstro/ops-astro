// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner's pass loop (`apps/site-runner/main.ts`, `passes`) over the
// real runner and its real queue claims, with no database: a `task.queue` the
// API refused, or one with no usable answer, fails the pass (#2005). It logs
// one fixed line, takes nothing off the queue and pings no heartbeat, so the
// operator's watcher mails. An empty queue still passes quietly and pings.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { queueClaims, type AgentCall, type Answer } from '../../apps/site-runner/claims.ts';
import { passes } from '../../apps/site-runner/main.ts';
import { createSiteRunner } from '../../apps/site-runner/runner.ts';

const PASSWORD = 'fixture-canary-password-3b9e41';

afterEach(() => {
  vi.restoreAllMocks();
});

interface Passed {
  readonly printed: string;
  readonly pings: number;
  readonly asked: readonly string[];
}

/** One pass of the loop with `task.queue` answering `queue`: what it printed, pinged and asked. */
async function onePass(queue: Answer): Promise<Passed> {
  const asked: string[] = [];
  const call: AgentCall = async (verb) => {
    asked.push(verb);
    return await Promise.resolve(verb === 'task.queue' ? queue : { fault: true as const });
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
    pass: async () => await runner.pass(),
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

  it('an empty queue passes quietly and pings', async () => {
    expect(await onePass({ detail: { queue: [] } })).toEqual({
      printed: '',
      pings: 1,
      asked: ['task.queue'],
    });
  });
});
