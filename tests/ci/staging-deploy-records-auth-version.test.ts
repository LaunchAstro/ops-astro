// SPDX-License-Identifier: AGPL-3.0-only
// A staging deploy record must carry the hosted sign-in server's version.

import { expect, it } from 'vitest';
import { deployWeb } from '../../scripts/ops/web-deploy.ts';
import { clean, fakeVercel, settings, STAGED, store } from './web-deploy.fixture.ts';

it('staging deploy records the sign-in server version alongside the build and function runtime', async () => {
  const vercel = fakeVercel();
  const outcome = await deployWeb(
    { version: STAGED, store: store() },
    { env: settings(vercel.path), preflight: clean },
  );

  expect(outcome.kind).toBe('deployed');
  if (outcome.kind !== 'deployed') return;
  expect(outcome.record.runtime).toBe('nodejs24.x');
  expect(
    Object.entries(outcome.record).some(
      ([name, value]) => /auth.*version|version.*auth/iu.test(name) && typeof value === 'string' && value.length > 0,
    ),
  ).toBe(true);
});
