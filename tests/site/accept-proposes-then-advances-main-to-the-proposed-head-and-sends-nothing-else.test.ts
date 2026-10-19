// SPDX-License-Identifier: AGPL-3.0-only
//
// #1986 on a real database: after Accept the site runner proposes (branch, the
// file on it, the request) and publishes by advancing the default branch to the
// proposal's head, and sends nothing else. The request then reads merged, so
// nothing is left open, and the receipt's revision is the head itself. Mutants
// that turn it red: restore the contents write on the default branch; send the
// head of a fresh read instead of the proposal row's.

import { describe, expect, it } from 'vitest';
import { HEAD } from './c80-site-provider.ts';
import { approved, receipt, serverUrl, w } from './c80-register-world.ts';
import { runnerOn, useRunnerWorld, world, writes } from './site-runner-world.ts';

useRunnerWorld();

describe.skipIf(serverUrl === undefined)('accept publishes by advancing main', () => {
  it('proposes, then advances main to the proposed head, and sends nothing else', async () => {
    const id = await approved();
    const given = world();
    const { runner } = runnerOn(id, given);

    expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'live' }]);

    expect(writes(given.site).map((sent) => `${sent.method} ${sent.target}`)).toEqual([
      'POST /repos/agency/site/git/refs',
      'PUT /repos/agency/site/contents/src/pages/about.md',
      'POST /repos/agency/site/pulls',
      'PATCH /repos/agency/site/git/refs/heads/main',
    ]);
    expect(writes(given.site)[1]?.body['branch']).not.toBe('main');
    expect(writes(given.site)[3]?.body).toEqual({ sha: HEAD });
    expect(given.site.state.mainHead).toBe(HEAD);
    expect(given.site.state.request?.merged).toBe(true);
    expect(await w.stateOf(id)).toBe('live');
    expect((await receipt(id, 'publish'))['published_revision']?.observed).toBe(HEAD);
    expect(given.raised).toEqual([]);
  });
});
