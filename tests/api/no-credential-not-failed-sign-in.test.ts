// SPDX-License-Identifier: AGPL-3.0-only
//
// A request carrying no credential is not a failed sign-in.
//
// The repeated-failed-sign-in alert mails the owner and the second operator.
// Anyone on the internet can send a request with no token at all: a crawler,
// an uptime probe, a person typing the address. Those are not sign-in
// attempts, and five of them must not raise the alert for a business.

import { describe, expect, it } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { createDetector } from '../../apps/api/alerts/detect.ts';
import type { AlertKind } from '../../apps/api/alerts/catalogue.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { testSignIn } from '../support/sign-in.ts';
import { BOARD, ISSUER, database, post } from './session-cookie.fixture.ts';

describe('a request carrying no credential is not a failed sign-in', () => {
  it('five anonymous calls to a business raise no sign-in alert', async () => {
    const raised: AlertKind[] = [];
    const detector = createDetector((kind) => raised.push(kind));
    const api = createApi({
      database,
      verify: createSupabaseVerifier(testSignIn(ISSUER)),
      resolveBusiness: (key) => Promise.resolve(key === 'alpha' ? 'business-alpha' : undefined),
      executeRead: (() => Promise.resolve({ ok: true, tasks: [] })) as never,
      executeCommand: (() => Promise.resolve({ recordId: 'r-1', revision: 1 })) as never,
      observe: detector.observe,
    });
    for (let n = 0; n < 5; n += 1) {
      // eslint-disable-next-line no-await-in-loop -- one call after another
      const answer = await post(api, BOARD, {});
      expect(answer.status).toBe(401);
    }
    expect(raised).toEqual([]);
  });
});
