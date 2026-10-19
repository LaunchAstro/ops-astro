// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest';
import { queueClaims, type AgentCall } from '../../apps/site-runner/claims.ts';
import { passes } from '../../apps/site-runner/main.ts';
import { createSiteRunner } from '../../apps/site-runner/runner.ts';

afterEach(() => vi.restoreAllMocks());

it('a refused queue cannot emit a healthy runner heartbeat', async () => {
  const asked: string[] = [];
  const call: AgentCall = (verb) => {
    asked.push(verb);
    return Promise.resolve({ refused: 'SCOPE_NOT_GRANTED' });
  };
  const claims = queueClaims(call, undefined as never, undefined as never);
  const runner = createSiteRunner({ claims, actorId: '' } as never);
  const stopping = new AbortController();
  let heartbeats = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await passes({
    pass: () => runner.pass(),
    ping: () => {
      heartbeats += 1;
      return Promise.resolve();
    },
    sleep: () => {
      stopping.abort();
      return Promise.resolve();
    },
    stopping: stopping.signal,
  });
  expect(asked).toStrictEqual(['task.queue']);
  expect(heartbeats, 'an unreadable queue must keep the failure watcher armed').toBe(0);
});
