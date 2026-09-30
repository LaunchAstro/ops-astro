// SPDX-License-Identifier: AGPL-3.0-only
//
// The staging web deploy on Vercel (ticket S0-6, the Vercel re-plan, section
// 11 step 4): `S0-6 deploy recorded` and the read-back half of `S0-6 functions
// in Sydney`. The stored build output is checked by its digest, deployed with
// `vercel deploy --prebuilt --prod` under the person's own Vercel sign-in, and
// its region read back from Vercel; only a deploy in `syd1` alone is recorded.
// `vercel` is the fixture's fake (web-deploy.fixture.ts). The operator gate in
// front of the command is proved in operator-only.test.ts.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { artefactName } from '../../scripts/ops/promotion.ts';
import { deployWeb } from '../../scripts/ops/web-deploy.ts';
import {
  AUTH_VERSION,
  CANARY,
  clean,
  fakeVercel,
  OUTPUT,
  PROJECT,
  scratch,
  settings,
  STAGED,
  store,
  SYDNEY,
  URL_MADE,
} from './web-deploy.fixture.ts';

describe('S0-6 deploy recorded, on Vercel', () => {
  recordedCase();
  cleanUpCase();
  refusedCases();
});

describe('S0-6 functions in Sydney, read back from Vercel', () => {
  regionCases();
  failedCliCases();
});

function recordedCase() {
  it('deploys the stored output prebuilt to the main address and records version, digest, deployment, region and sign-in server version', async () => {
    const at = store();
    const vercel = fakeVercel();
    const outcome = await deployWeb(
      { version: STAGED, store: at },
      { env: settings(vercel.path), preflight: clean },
    );
    const digest = JSON.parse(
      readFileSync(join(at, artefactName(STAGED), 'build.json'), 'utf8'),
    ) as { digest: string };
    expect(outcome).toStrictEqual({
      kind: 'deployed',
      record: {
        action: 'deploy recorded',
        version: STAGED,
        artefact: artefactName(STAGED),
        digest: digest.digest,
        deployment: URL_MADE,
        region: 'syd1',
        runtime: 'nodejs24.x',
        authVersion: AUTH_VERSION,
      },
    });
    expect(vercel.lines('argv')).toStrictEqual([
      'deploy --prebuilt --prod',
      `inspect ${URL_MADE} --format json`,
    ]);
    expect(vercel.lines('output')).toStrictEqual([
      JSON.stringify({ build: STAGED, digest: digest.digest }),
    ]);
    const log = readFileSync(vercel.log, 'utf8');
    expect(log).not.toContain(CANARY);
    expect(log).not.toMatch(/^env (?:OPS_ASTRO_|DATABASE_|VERCEL_TOKEN)/mu);
    expect(vercel.lines('env')).toContain(`VERCEL_PROJECT_ID=${PROJECT}`);
    expect(JSON.stringify(outcome)).not.toContain(CANARY);
    expect(JSON.stringify(outcome)).not.toContain(scratch);
  });
}

function cleanUpCase() {
  it('leaves no .vercel folder behind, in its working folder or the checkout', async () => {
    const vercel = fakeVercel();
    await deployWeb(
      { version: STAGED, store: store() },
      { env: settings(vercel.path), preflight: clean },
    );
    const [cwd] = vercel.lines('cwd');
    expect(cwd).toBeDefined();
    expect(existsSync(cwd!)).toBe(false);
    expect(existsSync(join(process.cwd(), '.vercel'))).toBe(false);
  });
}

function refusedCases() {
  it('refuses before Vercel is asked: bytes not the digest, a dirty build, edge code, a sign, a bad setting, no sign-in server version', async () => {
    const tampered = store();
    writeFileSync(join(tampered, artefactName(STAGED), 'static/index.html'), 'changed');
    const edge = store({
      ...OUTPUT,
      'functions/api.func/.vc-config.json': { ...SYDNEY, regions: ['iad1'] },
    });
    const cases: [string, Parameters<typeof deployWeb>[0], Record<string, string>, boolean][] = [
      ['tampered', { version: STAGED, store: tampered }, {}, false],
      ['dirty', { version: `${STAGED}-dirty`, store: store() }, {}, false],
      ['edge', { version: STAGED, store: edge }, {}, false],
      ['sign', { version: STAGED, store: store() }, {}, true],
      ['token', { version: STAGED, store: store() }, { VERCEL_TOKEN: CANARY }, false],
      ['org', { version: STAGED, store: store() }, { VERCEL_ORG_ID: `x${CANARY}` }, false],
      ['project', { version: STAGED, store: store() }, { VERCEL_PROJECT_ID: '' }, false],
      ['no auth', { version: STAGED, store: store() }, { GOTRUE_URL: '' }, false],
      ['foreign auth', { version: STAGED, store: store() }, { GOTRUE_URL: URL_MADE }, false],
      [
        'auth silent',
        { version: STAGED, store: store() },
        { GOTRUE_URL: 'http://127.0.0.1:1/auth/v1' },
        false,
      ],
    ];
    for (const [name, request, over, signs] of cases) {
      const vercel = fakeVercel();
      // oxlint-disable-next-line no-await-in-loop -- each case on its own
      const outcome = await deployWeb(request, {
        env: { ...settings(vercel.path), ...over },
        preflight: () => Promise.resolve(signs ? ['a view over a private table'] : []),
      });
      expect(outcome.kind, name).toBe('refused');
      expect(JSON.stringify(outcome), name).not.toContain(CANARY);
      expect(existsSync(vercel.log), name).toBe(false);
    }
  });
}

function regionCases() {
  it('a deployment Vercel reports anywhere but syd1 alone, or cannot report, is not recorded', async () => {
    for (const out of [
      JSON.stringify({ regions: ['iad1'] }),
      JSON.stringify({ regions: ['syd1', 'iad1'] }),
      JSON.stringify({ regions: [] }),
      JSON.stringify({ regions: 'syd1' }),
      JSON.stringify({}),
      'not json',
    ]) {
      const vercel = fakeVercel({ inspect: { out, status: 0 } });
      // oxlint-disable-next-line no-await-in-loop -- each answer on its own
      const outcome = await deployWeb(
        { version: STAGED, store: store() },
        { env: settings(vercel.path), preflight: clean },
      );
      expect(outcome.kind, out).toBe('failed');
      expect(outcome.kind === 'failed' && outcome.reason, out).toMatch(/syd1/u);
    }
  });
}

function failedCliCases() {
  it('a deploy Vercel refuses, or answers without a deployment address, records nothing', async () => {
    for (const deploy of [
      { out: '', status: 1 },
      { out: URL_MADE, status: 1 },
      { out: 'Error: not signed in', status: 0 },
      { out: 'https://elsewhere.example.test', status: 0 },
    ]) {
      const vercel = fakeVercel({ deploy });
      // oxlint-disable-next-line no-await-in-loop -- each answer on its own
      const outcome = await deployWeb(
        { version: STAGED, store: store() },
        { env: settings(vercel.path), preflight: clean },
      );
      expect(outcome.kind, deploy.out).toBe('failed');
      expect(vercel.lines('argv'), deploy.out).toStrictEqual(['deploy --prebuilt --prod']);
    }
  });
}
