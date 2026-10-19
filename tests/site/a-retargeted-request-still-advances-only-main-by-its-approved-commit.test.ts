// SPDX-License-Identifier: AGPL-3.0-only
//
// #1986 on a real database: a review request retargeted to another branch on the
// provider changes nothing the runner sends. The publish names the default
// branch itself, so main is advanced to the approved head and the other branch
// receives nothing; the request is not closed by that, so one person task names
// it left open. Mutant that turns it red: take the branch from the request.

import { describe, expect, it } from 'vitest';
import type { TransportRequest } from '../../packages/core-connectors/src/index.ts';
import { BEFORE } from './c80-world.ts';
import { HEAD } from './c80-site-provider.ts';
import { approved, serverUrl } from './c80-register-world.ts';
import { runnerOn, useRunnerWorld, world, writes } from './site-runner-world.ts';

useRunnerWorld();

describe.skipIf(serverUrl === undefined)('a retargeted review request', () => {
  it('still advances only main, by the approved commit, and names the request left open', async () => {
    const id = await approved();
    const given = world();
    const transport = given.site.deps.transport;
    Object.assign(given.site.deps, {
      transport: async (request: TransportRequest) => {
        const answer = await transport(request);
        // Retargeted on the provider as soon as it is opened.
        if (request.method === 'POST' && request.url.pathname.endsWith('/pulls'))
          given.site.state.request = { ...given.site.state.request!, base: 'staging' };
        return answer;
      },
    });
    const { runner } = runnerOn(id, given);

    expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'live' }]);

    const advances = writes(given.site).filter((sent) => sent.method === 'PATCH');
    expect(advances.map((sent) => sent.target)).toEqual(['/repos/agency/site/git/refs/heads/main']);
    expect(advances[0]?.body).toEqual({ sha: HEAD });
    expect(given.site.state.stagingContent).toBe(BEFORE);
    expect(given.site.state.request?.merged).toBe(false);
    expect(given.raised).toEqual(['REQUEST_LEFT_OPEN']);
  });
});
