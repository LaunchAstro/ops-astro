// SPDX-License-Identifier: AGPL-3.0-only
//
// Red proof (REVIEW-MAIN-B1 p14-1): the egress relay's `serverName` names a
// host from a ClientHello cut inside its server name. staging-egress.test.ts
// claims "a short or malformed hello names nothing" but asserts only that the
// cut hello does not name the whole host, so a truncated name passes it.

import { describe, expect, it } from 'vitest';
import { hello } from './staging-egress.fixture.ts';

type EgressModule = { serverName: (hello: Buffer) => string | undefined };
const EGRESS = '../../scripts/ops/egress.mjs';
const { serverName } = (await import(/* @vite-ignore */ EGRESS)) as EgressModule;

describe('S0-1 egress relay: a hello cut short names nothing', () => {
  it('every cut of a ClientHello inside its server name names nothing, never a truncated host', () => {
    const whole = hello('api.example.test');
    const named: string[] = [];
    for (let cut = 0; cut < whole.length; cut += 1) {
      const name = serverName(whole.subarray(0, cut));
      if (name !== undefined) named.push(`${cut}:${name}`);
    }
    expect(
      named,
      'egress serverName names a truncated host from a short ClientHello (relay refuses or misroutes a hello split mid-SNI)',
    ).toEqual([]);
  });
});
