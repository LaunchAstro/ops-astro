// SPDX-License-Identifier: AGPL-3.0-only
// The version deploy names a missing publishable key as a setting up front
// (#1985), before the preflight or the sign-in server is asked.

import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { deployWeb } from '../../scripts/ops/web-deploy.ts';
import { authReads, clean, fakeVercel, settings, STAGED, store } from './web-deploy.fixture.ts';

it('names a missing publishable key as a setting before any network read', async () => {
  const vercel = fakeVercel();
  let preflights = 0;
  const reads = authReads();
  const outcome = await deployWeb(
    { version: STAGED, store: store() },
    {
      env: { ...settings(vercel.path), SUPABASE_PUBLISHABLE_KEY: '' },
      preflight: () => {
        preflights += 1;
        return clean();
      },
    },
  );
  expect(outcome.kind).toBe('refused');
  expect(outcome.kind === 'refused' && outcome.reason).toMatch(
    /^SUPABASE_PUBLISHABLE_KEY is not set/u,
  );
  expect(preflights).toBe(0);
  expect(authReads()).toBe(reads);
  expect(existsSync(vercel.log)).toBe(false);
});
