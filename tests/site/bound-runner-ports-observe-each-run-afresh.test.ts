// SPDX-License-Identifier: AGPL-3.0-only
//
// One set of bound runner ports observes each run afresh: a revert served after
// its publish reads reverted, and an alias read that failed once does not keep
// failing every later observation on the same ports.

import { describe, expect, it } from 'vitest';
import { json } from './c80-site-provider.ts';
import { bound } from './c80-site-ports-bound.ts';
import { approved, publish, revert, serverUrl, useRegisterWorld, w } from './c80-register-world.ts';

useRegisterWorld();

describe.skipIf(serverUrl === undefined)('bound runner ports', () => {
  it('the same bound ports observe a successfully served revert', async () => {
    const id = await approved();
    const { site, ports, raised } = await bound(id);
    const runner = ports();
    expect(await publish(id, runner)).toMatchObject({ kind: 'recorded', state: 'live' });
    // RunnerPorts exposes publish and revert for this same bound correction. The
    // provider now serves the revert on the same project's production domain.
    expect(await revert(id, runner)).toMatchObject({ kind: 'recorded', state: 'reverted' });
    expect(await w.stateOf(id)).toBe('reverted');
    expect(raised).toEqual([]);
    // One advance published it, one contents write reverted it forward.
    expect(site.sent.map((request) => request.method).filter((method) => method !== 'GET')).toEqual(
      ['PATCH', 'PUT'],
    );
  });

  it('a transient alias failure does not poison later observation on the bound ports', async () => {
    const id = await approved();
    const { site, ports } = await bound(id);
    const runner = ports();
    site.state.answers['GET api.vercel.com /v4/aliases/'] = json(
      { error: 'temporary outage' },
      500,
    );
    const first = await publish(id, runner);
    delete site.state.answers['GET api.vercel.com /v4/aliases/'];
    // Observe the registered effect again after the provider recovers.
    const retried =
      first.kind === 'recorded' && first.state === 'live' ? first : await publish(id, runner);
    expect(retried).toMatchObject({ kind: 'recorded', state: 'live' });
    expect(site.sent.filter((request) => request.method === 'PATCH')).toHaveLength(1);
  });
});
