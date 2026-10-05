// SPDX-License-Identifier: AGPL-3.0-only
//
// The staging web deploy on Vercel (ticket S0-6, the Vercel re-plan, section
// 11 step 4): `S0-6 deploy recorded`. The stored build output is checked by
// its digest, deployed with `vercel deploy --prebuilt --prod` under the
// person's own Vercel sign-in, and read back with `vercel inspect <address>
// --format json`. Only a deployment Vercel reports as the one just made (its
// `url`), on `production` (its `target`) and `READY` (its `readyState`) is
// recorded. The CLI's answer is not read for a region: the `syd1` recorded is
// the one the build output declares, held by `buildOutputProblems` before
// Vercel is asked (s0-6-functions-in-sydney.test.ts).
// `vercel` is the fixture's fake (web-deploy.fixture.ts). The operator gate in
// front of the command is proved in operator-only.test.ts.

import { existsSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { artefactName } from '../../scripts/ops/promotion.ts';
import { deployWeb } from '../../scripts/ops/web-deploy.ts';
import {
  AUTH_VERSION,
  CANARY,
  clean,
  fakeVercel,
  INSPECTED,
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

describe('S0-6 deploy recorded only when Vercel reads it back ready on production', () => {
  readBackCases();
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

  // Security read SEC-OPS-REBUILD-3c finding 2: the copy of a link is a link,
  // and its digest read through it would match while the store's bytes change.
  it('refuses a stored output swapped for a link after it was selected, before Vercel deploys', async () => {
    const at = store();
    const artefact = join(at, artefactName(STAGED));
    const vercel = fakeVercel();
    const outcome = await deployWeb(
      { version: STAGED, store: at },
      {
        env: settings(vercel.path),
        preflight: () => {
          renameSync(artefact, `${artefact}-moved`);
          symlinkSync(`${artefact}-moved`, artefact);
          return clean();
        },
      },
    );
    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: expect.stringContaining('the copy does not hold the digested bytes'),
    });
    expect(existsSync(vercel.log)).toBe(false);
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

/** One `vercel inspect` answer, named for the failure message. */
interface Answer {
  readonly label: string;
  readonly out: string;
  readonly status?: number;
}

/** Deploys once with `inspect` answering `out`: the outcome and the calls made. */
async function deployAnswering(out: string, status = 0) {
  const vercel = fakeVercel({ inspect: { out, status } });
  const outcome = await deployWeb(
    { version: STAGED, store: store() },
    { env: settings(vercel.path), preflight: clean },
  );
  return { outcome, argv: vercel.lines('argv') };
}

/** Each answer, deployed on its own, ends failed after Vercel was asked, with no record. */
async function expectUnrecorded(answers: readonly Answer[]) {
  for (const { label, out, status } of answers) {
    // oxlint-disable-next-line no-await-in-loop -- each answer on its own
    const { outcome, argv } = await deployAnswering(out, status);
    expect(outcome.kind, label).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.reason, label).toMatch(
      /did not report https:\/\/\S+ ready on production/u,
    );
    expect(argv, label).toStrictEqual([
      'deploy --prebuilt --prod',
      `inspect ${URL_MADE} --format json`,
    ]);
  }
}

const answering = (over: Record<string, unknown>): string =>
  JSON.stringify({ ...INSPECTED, ...over });

/** A case that deploys several times waits longer than one deploy's default. */
const SEVERAL_DEPLOYS = { timeout: 30_000 };

const UNRECORDED: readonly [string, readonly Answer[]][] = [
  [
    'a read-back naming another deployment, or none, is not recorded',
    [
      {
        label: 'another deployment',
        out: answering({ url: 'ops-astro-staging-z9y8x7w6v.vercel.app' }),
      },
      { label: 'with its scheme', out: answering({ url: URL_MADE }) },
      { label: 'no url', out: answering({ url: undefined }) },
    ],
  ],
  [
    'a read-back on any target but production is not recorded',
    [
      { label: 'preview', out: answering({ target: 'preview' }) },
      { label: 'staging', out: answering({ target: 'staging' }) },
      { label: 'no target', out: answering({ target: null }) },
    ],
  ],
  [
    'a read-back in any state but READY is not recorded',
    [
      { label: 'BUILDING', out: answering({ readyState: 'BUILDING' }) },
      { label: 'ERROR', out: answering({ readyState: 'ERROR' }) },
      { label: 'QUEUED', out: answering({ readyState: 'QUEUED' }) },
      { label: 'CANCELED', out: answering({ readyState: 'CANCELED' }) },
      { label: 'ready', out: answering({ readyState: 'ready' }) },
    ],
  ],
  [
    'a read-back Vercel cannot give is not recorded',
    [
      { label: 'inspect failed', out: answering({}), status: 1 },
      { label: 'empty object', out: '{}' },
      { label: 'not json', out: 'not json' },
      { label: 'empty', out: '' },
    ],
  ],
];

function readBackCases() {
  it('records the deployment Vercel reads back as the one made, on production, READY', async () => {
    const { outcome } = await deployAnswering(answering({}));
    expect(outcome.kind).toBe('deployed');
  });
  for (const [title, answers] of UNRECORDED) {
    it(title, SEVERAL_DEPLOYS, () => expectUnrecorded(answers));
  }
}

function failedCliCases() {
  it(
    'a deploy Vercel refuses, or answers without a deployment address, records nothing',
    SEVERAL_DEPLOYS,
    async () => {
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
    },
  );
}
