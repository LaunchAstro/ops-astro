// SPDX-License-Identifier: AGPL-3.0-only
//
// #1986 on a real database: the accepted residual of S2106-1 (register 176). A
// push to the review request after its last read and before the advance reaches
// the provider cannot stop the advance, which is conditional on main only. The
// site gets exactly the approved commit, the request is left open, and one person
// task names it. Mutant that turns it red: skip the request read once live.

import { describe, expect, it } from 'vitest';
import type { TransportRequest } from '../../packages/core-connectors/src/index.ts';
import { AFTER } from './c80-world.ts';
import { HEAD } from './c80-site-provider.ts';
import { approved, serverUrl, w } from './c80-register-world.ts';
import { runnerOn, useRunnerWorld, world, writes } from './site-runner-world.ts';

useRunnerWorld();

describe.skipIf(serverUrl === undefined)('a push to the review request during the advance', () => {
  it('lands exactly the approved commit, leaves the request open and raises one task', async () => {
    const id = await approved();
    const given = world();
    const transport = given.site.deps.transport;
    Object.assign(given.site.deps, {
      transport: async (request: TransportRequest) => {
        // Another actor pushes onto the request as the advance reaches the provider.
        if (request.method === 'PATCH') {
          given.site.state.parents['c0ffee77'] = HEAD;
          given.site.state.request = { ...given.site.state.request!, head: 'c0ffee77' };
        }
        return await transport(request);
      },
    });
    const { runner } = runnerOn(id, given);

    expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'live' }]);
    const advances = writes(given.site).filter((sent) => sent.method === 'PATCH');
    expect(advances.map((sent) => sent.body)).toEqual([{ sha: HEAD }]);
    expect(given.site.state.mainHead).toBe(HEAD);
    expect(given.site.state.content).toBe(AFTER);
    expect(given.site.state.request?.merged).toBe(false);
    expect(await w.stateOf(id)).toBe('live');
    expect(given.raised).toEqual(['REQUEST_LEFT_OPEN']);
  });
});
