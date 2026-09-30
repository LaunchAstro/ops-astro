// SPDX-License-Identifier: AGPL-3.0-only
// S0-1g: the gated stop of production's worker and its forwarder (ticket S0-1).
//
// The promotion refuses while the API or the auth server runs (owner line 63),
// so a person stops them first. That stop is `scripts/ops/stop-production.mjs`:
// the operator gate answers first, then the service manager is asked to stop
// exactly the two named services with a fixed argument list, then the stop is
// recorded. An agent credential, a call under a delegation, a person without
// the key, a person holding it for one client only and another business's
// operator are each refused before the service manager is asked, and a refusal
// writes nothing: no record and no sign-in row. The service manager here is a
// fake on a PATH that holds no real docker, so no live service is touched.

import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { STOP, CANARY, scratch, fake, spawn, untouched } from './service-stop.fixture.ts';

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('S0-1 gated stop, before any lookup', () => {
  it('takes no argument: a caller cannot name a service, and nothing is asked', () => {
    for (const args of [['docker:prod-db'], ['--api', 'docker:prod-db'], ['ops-astro-api']]) {
      const at = fake();
      const result = spawn(STOP, args, { PATH: at.path, OPS_ASTRO_DEPLOYMENTS: at.records });
      expect(result.status, result.out).toBe(2);
      expect(result.out).toMatch(/takes no argument; it stops only production's worker unit/u);
      untouched(at);
    }
  });

  it('with no sign-in is refused and asks nothing of the machine', () => {
    const at = fake();
    const result = spawn(STOP, [], {
      PATH: at.path,
      OPS_ASTRO_DEPLOYMENTS: at.records,
      DATABASE_URL: 'postgres://nobody@127.0.0.1:1/never',
      DATABASE_ADMIN_URL: `postgres://owner:${CANARY}@127.0.0.1:1/never`,
    });
    expect(result.status, result.out).toBe(1);
    expect(result.out).toMatch(/REFUSED.*operations:manage/su);
    expect(result.out).not.toContain(CANARY);
    untouched(at);
  });

  it('flagged as an agent is refused before any lookup and asks nothing', () => {
    const at = fake();
    const result = spawn(STOP, [], {
      PATH: at.path,
      OPS_ASTRO_DEPLOYMENTS: at.records,
      OPS_ASTRO_AGENT: '1',
      OPS_ASTRO_TOKEN: CANARY,
      OPS_ASTRO_BUSINESS: 'alpha',
    });
    expect(result.status, result.out).toBe(1);
    expect(result.out).toMatch(/OPS_ASTRO_AGENT is set/u);
    expect(result.out).not.toContain(CANARY);
    untouched(at);
  });
});
