// SPDX-License-Identifier: AGPL-3.0-only
//
// The staging web deploy on Vercel (ticket S0-6, the Vercel re-plan, section
// 11 step 4): `S0-6 deploy recorded` and the read-back half of `S0-6 functions
// in Sydney`. The stored build output is checked by its digest, deployed with
// `vercel deploy --prebuilt --prod` under the person's own Vercel sign-in, and
// its region read back from Vercel; only a deploy in `syd1` alone is recorded.
// `vercel` here is a fake on PATH that logs its arguments, working folder and
// environment and answers as told: no real deploy, no network. The operator
// gate in front of the command is proved in operator-only.test.ts.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outputDigest } from '../../scripts/ops/build-output.ts';
import { artefactName } from '../../scripts/ops/promotion.ts';
import { deployWeb } from '../../scripts/ops/web-deploy.ts';

const STAGED = '0123456789ab';
const CANARY = 'canary-5d19e0-web-deploy-secret';
const URL_MADE = 'https://ops-astro-staging-a1b2c3d4e.vercel.app';
const ORG = 'team_madeUpOrg0123';
const PROJECT = 'prj_madeUpProject0123';

let scratch = '';
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 's0-6-web-'));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let made = 0;
const folder = (name: string): string => {
  made += 1;
  const path = join(scratch, `${name}-${String(made)}`);
  mkdirSync(path, { recursive: true });
  return path;
};

type Files = Record<string, string | object>;
const SYDNEY = { runtime: 'nodejs24.x', handler: 'index.mjs', regions: ['syd1'] };
const OUTPUT: Files = {
  'config.json': { version: 3, routes: [{ handle: 'filesystem' }] },
  'static/index.html': '<!doctype html><title>Ops Astro</title>',
  'functions/api.func/.vc-config.json': SYDNEY,
  'functions/api.func/index.mjs': 'export {};',
};

/** An artefact store holding one release output for `version`, stamped and digested. */
function store(files: Files = OUTPUT, version = STAGED): string {
  const root = folder('store');
  const out = join(root, artefactName(version));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), typeof body === 'string' ? body : JSON.stringify(body));
  }
  writeFileSync(join(out, 'build.json'), JSON.stringify({ build: version }));
  writeFileSync(
    join(out, 'build.json'),
    JSON.stringify({ build: version, digest: outputDigest(out) }),
  );
  return root;
}

interface Answers {
  deploy?: { out: string; status: number };
  inspect?: { out: string; status: number };
}

/** A `vercel` on PATH that logs each call and answers as told. */
function fakeVercel(answers: Answers = {}) {
  const bin = folder('bin');
  const log = join(bin, 'calls.log');
  const deploy = answers.deploy ?? { out: URL_MADE, status: 0 };
  const inspect = answers.inspect ?? {
    out: JSON.stringify({ url: URL_MADE.slice('https://'.length), regions: ['syd1'] }),
    status: 0,
  };
  writeFileSync(join(bin, 'deploy.out'), `${deploy.out}\n`);
  writeFileSync(join(bin, 'inspect.out'), `${inspect.out}\n`);
  writeFileSync(
    join(bin, 'vercel'),
    [
      '#!/bin/sh',
      `log='${log}'`,
      'printf "argv %s\\n" "$*" >> "$log"',
      'printf "cwd %s\\n" "$PWD" >> "$log"',
      'env | sed "s/^/env /" >> "$log"',
      'if [ "$1" = deploy ]; then',
      '  printf "output %s\\n" "$(cat .vercel/output/build.json)" >> "$log"',
      '  mkdir -p .vercel && echo "{}" > .vercel/project.json',
      `  cat '${join(bin, 'deploy.out')}'; exit ${String(deploy.status)}`,
      'fi',
      `if [ "$1" = inspect ]; then cat '${join(bin, 'inspect.out')}'; exit ${String(inspect.status)}; fi`,
      'exit 2',
    ].join('\n'),
  );
  chmodSync(join(bin, 'vercel'), 0o755);
  const lines = (kind: string): string[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line.startsWith(`${kind} `))
          .map((line) => line.slice(kind.length + 1))
      : [];
  return { path: `${bin}:${process.env['PATH'] ?? ''}`, log, lines };
}

const settings = (path: string): Record<string, string> => ({
  PATH: path,
  HOME: process.env['HOME'] ?? '',
  VERCEL_ORG_ID: ORG,
  VERCEL_PROJECT_ID: PROJECT,
  OPS_ASTRO_TOKEN: CANARY,
  DATABASE_URL: `postgres://app:${CANARY}@127.0.0.1:1/never`,
  DATABASE_ADMIN_URL: `postgres://owner:${CANARY}@127.0.0.1:1/never`,
});

const clean = (): Promise<string[]> => Promise.resolve([]);

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
  it('deploys the stored output prebuilt to the main address and records version, digest, deployment and region', async () => {
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
  it('refuses before Vercel is asked: bytes not the digest, a dirty build, edge code, a sign, a bad setting', async () => {
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
