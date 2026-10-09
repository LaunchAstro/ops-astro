// SPDX-License-Identifier: AGPL-3.0-only
import { expect } from 'vitest';
import { A, timerWorld } from './task-bound-timer-support.tsx';
import { task } from './task-page-stub.tsx';

export function diagnosticWorld() {
  const world = timerWorld();
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    const path = String(url).replace(/^.*?(\/[a-z]+\/[a-z_]+)$/u, '$1');
    requests.push({
      path,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    if (path === '/task/execution') {
      const recordId = requests.at(-1)?.body['recordId'];
      expect(recordId === 'Timer-A' || recordId === A).toBe(true);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            execution: {
              taskId: A,
              sourceRevision: task().revision,
              outcome: 'no-run',
              runs: [],
              events: [],
              complete: true,
              next: null,
              graph: { plan: 'unbound', sourceRevision: 1, complete: true, nodes: [] },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    return world.fetch(url, init);
  };
  return {
    ...world,
    fetch,
    requests,
    counts: () => ({
      taskReads: requests.filter((one) => one.path === '/task/read').length,
      executionReads: requests.filter((one) => one.path === '/task/execution').length,
      commands: requests.filter((one) => one.body['operationId'] !== undefined).length,
    }),
  };
}
