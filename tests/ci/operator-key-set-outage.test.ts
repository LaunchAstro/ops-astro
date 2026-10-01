// SPDX-License-Identifier: AGPL-3.0-only
//
// FIX-B1 review round 1, rs-4. The operator check verifies the bearer the way
// the API does. When the provider's key set cannot be reached, the check still
// refuses, and says the key set did not answer, not that the sign-in was
// missing, forged or expired.

import { describe, expect, it } from 'vitest';
import { requireOperator } from '../../scripts/ops/operator.ts';
import { signBearer } from '../support/sign-in.ts';

// Port 1 on loopback: nothing listens, so the key set fetch is refused at once.
const ISSUER = 'http://127.0.0.1:1';

describe('FIX-B1 rs-4: the operator check during a key set outage', () => {
  it('refuses, naming the outage rather than a bad sign-in', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signBearer({
      sub: 'mia',
      aud: 'authenticated',
      iss: ISSUER,
      role: 'authenticated',
      iat: now,
      exp: now + 600,
    });
    const gate = await requireOperator({
      OPS_ASTRO_TOKEN: token,
      OPS_ASTRO_BUSINESS: 'alpha',
      OPS_ASTRO_DEPLOYMENTS: '/nowhere/records',
      DATABASE_URL: 'postgres://nobody@127.0.0.1:1/never',
      DATABASE_ADMIN_URL: 'postgres://nobody@127.0.0.1:1/never',
      GOTRUE_URL: ISSUER,
    });

    expect(gate.ok).toBe(false);
    const reason = gate.ok ? '' : gate.reason;
    expect(reason).not.toMatch(/missing, forged or expired/u);
    expect(reason).toMatch(/key set/u);
  });
});
