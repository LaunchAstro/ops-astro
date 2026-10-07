// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- keep each regression's setup and assertions together */
// Concurrent preview behaviour is covered separately with #496.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { outputDigest, recordedStamp, stampOutput } from '../../scripts/ops/build-output.ts';
import { artefactName, promote } from '../../scripts/ops/promotion.ts';
import { trustedTemp } from './promotion.fixture.ts';
import { serveTestKeySetApart, signBearer, TEST_ISSUER } from '../support/sign-in.ts';

it('a malformed database address never prints its password', async () => {
  const keys = await serveTestKeySetApart();
  const password = 'sol-ow065-synthetic-password-canary';
  try {
    const token = await signBearer({
      sub: 'sol-ow065-person',
      aud: 'authenticated',
      iss: TEST_ISSUER,
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const result = spawnSync(process.execPath, ['scripts/ops/operator.mjs', 'prepare'], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'],
        OPS_ASTRO_TOKEN: token,
        OPS_ASTRO_BUSINESS: 'alpha',
        OPS_ASTRO_DEPLOYMENTS: '/unused-sol-ow065-records',
        GOTRUE_URL: TEST_ISSUER,
        SUPABASE_KEY_SET_URL: keys.url,
        DATABASE_ADMIN_URL: `postgres://owner:${password}@127.0.0.1:bad/database`,
        DATABASE_URL: 'postgres://runtime@127.0.0.1:1/unused',
      },
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain(password);
  } finally {
    await keys.close();
  }
});

it('promotion serves the validated bytes despite a store write during migration', () => {
  // Moved under a folder the promotion's trust walk accepts (OPS497TRUST).
  const store = trustedTemp('sol-ow065-store-');
  try {
    const version = '0123456789ab';
    const artefact = join(store, artefactName(version));
    mkdirSync(artefact);
    writeFileSync(join(artefact, 'index.html'), 'the bytes tried on staging');
    stampOutput(artefact, version);
    const stagedDigest = outputDigest(artefact);
    expect(recordedStamp(artefact).digest).toBe(stagedDigest);
    let served: string | undefined;
    const outcome = promote(
      {
        version,
        store,
        line: 'Tried this artefact on staging.',
        dryRun: false,
        api: { manager: 'docker', name: 'prod-api' },
        auth: { manager: 'launchd', name: 'prod-auth' },
        current: join(store, 'current'),
      },
      {
        services: () => [
          { manager: 'docker', name: 'prod-api', running: false },
          { manager: 'launchd', name: 'prod-auth', running: false },
        ],
        migrate: () => {
          // Another process can write the mutable store while migrations run.
          writeFileSync(join(artefact, 'index.html'), 'unvalidated replacement bytes');
          return true;
        },
        point: (_link, selected) => {
          served = selected;
        },
        start: () => {},
      },
    );
    expect(readFileSync(join(artefact, 'index.html'), 'utf8')).toBe(
      'unvalidated replacement bytes',
    );
    // Refusal is safe; a promotion must serve the original validated digest.
    if (outcome.kind === 'promoted') {
      expect(served).toBeDefined();
      expect(outputDigest(served!)).toBe(stagedDigest);
    } else {
      expect(served).toBeUndefined();
    }
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});
