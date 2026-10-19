// SPDX-License-Identifier: AGPL-3.0-only
//
// #1986 on a real database: once the advance is live, the runner reads the review
// request. A provider that has not closed it as merged leaves the page right and
// the receipt live, and one person task names the request left open; a request
// closed as merged raises nothing. Mutant that turns it red: skip the read.

import { describe, expect, it } from 'vitest';
import { approved, serverUrl, w } from './c80-register-world.ts';
import { runnerOn, useRunnerWorld, world } from './site-runner-world.ts';

useRunnerWorld();

describe.skipIf(serverUrl === undefined)('a request left open after the advance', () => {
  it('stays live and raises one task naming the request left open', async () => {
    const id = await approved();
    const given = world();
    given.site.state.closesRequests = false;
    const { runner } = runnerOn(id, given);

    expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'live' }]);
    expect(await w.stateOf(id)).toBe('live');
    expect(given.site.state.request?.merged).toBe(false);
    expect(given.raised).toEqual(['REQUEST_LEFT_OPEN']);
  });
});
