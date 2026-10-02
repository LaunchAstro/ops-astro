// SPDX-License-Identifier: AGPL-3.0-only
// Review proof (REVIEW-MAIN-B1 p12-1): the web deploy reads the deployment's
// region from `vercel inspect <url> --format json`, but the Vercel CLI's JSON
// answer carries no `regions` field. Vercel CLI 54.17.3, `printJson` in
// dist/commands-bulk.js, writes exactly: id, name, url, target, readyState,
// createdAt, and aliases, builds, routes, contextName when present. The
// suite's fake `vercel` answers `{ url, regions: ['syd1'] }`, a field the real
// CLI never prints, so the green case proves nothing about the real CLI.
//
// Here the fake answers as the real CLI does for a ready production
// deployment of the stored output (its function in syd1). A deploy that
// worked is expected to be recorded; on main it is `failed`, after
// `vercel deploy --prebuilt --prod` has already put it on the main address.

import { expect, it } from 'vitest';
import { deployWeb } from '../../scripts/ops/web-deploy.ts';
import { clean, fakeVercel, settings, STAGED, store, URL_MADE } from '../ci/web-deploy.fixture.ts';

/** `vercel inspect <url> --format json` as Vercel CLI 54.17.3 prints it (printJson). */
const REAL_INSPECT_JSON = JSON.stringify(
  {
    id: 'dpl_madeUp0123456789abcdef',
    name: 'ops-astro-staging',
    url: URL_MADE.slice('https://'.length),
    target: 'production',
    readyState: 'READY',
    createdAt: 1_759_276_800_000,
    aliases: ['staging.example.test'],
    contextName: 'made-up-team',
  },
  null,
  2,
);

it('p12-1 web deploy records a syd1 deployment when vercel inspect answers as the real CLI does', async () => {
  const vercel = fakeVercel({ inspect: { out: REAL_INSPECT_JSON, status: 0 } });
  const outcome = await deployWeb(
    { version: STAGED, store: store() },
    { env: settings(vercel.path), preflight: clean },
  );
  expect(vercel.lines('argv')[0]).toBe('deploy --prebuilt --prod');
  expect(
    outcome.kind,
    `DEFECT p12-1: web-deploy reads 'regions' from 'vercel inspect --format json', which the real Vercel CLI never prints, so every real deploy is refused as not in syd1 after --prod already made it live: ${JSON.stringify(outcome)}`,
  ).toBe('deployed');
});
