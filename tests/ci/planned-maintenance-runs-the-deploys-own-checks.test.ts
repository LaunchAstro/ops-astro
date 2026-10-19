// SPDX-License-Identifier: AGPL-3.0-only
// Sol's proofs for #2111, assertions as given: a planned maintenance makes
// every check its version's deploy makes before Vercel is asked (the copy's
// build output and digest, the operator's held grant), not only the ones
// before the copy, so the page never goes up for a version that cannot
// deploy.

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { artefactName } from '../../scripts/ops/promotion.ts';
import { deployMaintenance, deployWeb } from '../../scripts/ops/web-deploy.ts';
import { staged } from './promotion.fixture.ts';
import {
  AUTH_VERSION,
  CANARY,
  clean,
  fakeVercel,
  OUTPUT,
  settings,
  STAGED,
  store,
  SYDNEY,
} from './web-deploy.fixture.ts';

afterEach(() => vi.unstubAllGlobals());

it('planned maintenance refuses an artefact the version deploy rejects outside Sydney', async () => {
  const vercel = fakeVercel();
  const env = settings(vercel.path);
  const request = {
    version: STAGED,
    store: store({
      ...OUTPUT,
      'functions/api.func/.vc-config.json': { ...SYDNEY, regions: ['iad1'] },
    }),
  };
  const options = { env, preflight: clean };
  const version = await deployWeb(request, options);
  expect(version).toMatchObject({
    kind: 'refused',
    reason: expect.stringContaining('does not run in syd1 alone'),
  });
  expect(existsSync(vercel.log)).toBe(false);
  const maintenance = await deployMaintenance({ env }, { request, options });
  expect(maintenance).toMatchObject({ kind: 'refused' });
  expect(vercel.lines('argv')).toEqual([]);
});

it('planned maintenance rechecks the artefact digest after preflight waits', async () => {
  const vercel = fakeVercel();
  const env = settings(vercel.path);
  const changed = () => {
    const root = store();
    return {
      request: { version: STAGED, store: root },
      options: {
        env,
        preflight: () => {
          writeFileSync(
            join(root, artefactName(STAGED), 'static/index.html'),
            'changed during preflight',
          );
          return Promise.resolve([]);
        },
      },
    };
  };
  const first = changed();
  expect(await deployWeb(first.request, first.options)).toMatchObject({
    kind: 'refused',
    reason: expect.stringContaining('does not hold the digested bytes'),
  });
  expect(existsSync(vercel.log)).toBe(false);
  expect(await deployMaintenance({ env }, changed())).toMatchObject({ kind: 'refused' });
  expect(vercel.lines('argv')).toEqual([]);
});

it('planned production maintenance refuses when the operator grant no longer admits the deploy', async () => {
  vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ version: AUTH_VERSION })));
  const vercel = fakeVercel();
  const production = 'zyxwvutsrqzyxwvutsrq';
  const env = {
    ...settings(vercel.path),
    STAGING_PROJECT_REF: 'abcdefghijabcdefghij',
    PRODUCTION_PROJECT_REF: production,
    DATABASE_ADMIN_URL: `postgresql://postgres.${production}:${CANARY}@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres?sslmode=require`,
    GOTRUE_URL: `https://${production}.supabase.co/auth/v1`,
  };
  const root = store();
  const request = { version: STAGED, store: root };
  const options = {
    env,
    preflight: clean,
    environment: 'production' as const,
    records: staged(root),
    authorised: <T>(_work: () => Promise<T>): Promise<T> =>
      Promise.reject(new Error('the operator no longer holds operations:manage')),
  };
  expect(await deployWeb(request, options)).toMatchObject({
    kind: 'refused',
    reason: expect.stringContaining('no longer holds operations:manage'),
  });
  expect(existsSync(vercel.log)).toBe(false);
  expect(await deployMaintenance({ env }, { request, options })).toMatchObject({ kind: 'refused' });
  expect(vercel.lines('argv')).toEqual([]);
});
