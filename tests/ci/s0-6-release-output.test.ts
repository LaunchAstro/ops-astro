// SPDX-License-Identifier: AGPL-3.0-only
//
// The release step (tickets S0-1 and S0-6, the Vercel re-plan, section 5's
// release.mjs row): the web build and the API as one build output in
// Vercel's Build Output API layout, built once. Asked of the real
// `scripts/ops/release.ts` over a stamped web build: the output passes
// `S0-6 functions in Sydney`; every `/api` answer is sent private and
// no-store and every other path is a static file, so no page response is made
// from records (`S0-6 no edge caching`, its second half); its digest is the
// same for the same input and moves with one byte; no environment value is
// baked in; and the function in it is the entry, bundled and working.

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildOutputProblems } from '../../scripts/ops/build-output.ts';
import { artefactName } from '../../scripts/ops/promotion.ts';
import { outputDigest, release } from '../../scripts/ops/release.ts';
import { deployWeb } from '../../scripts/ops/web-deploy.ts';
import { clean, fakeVercel, settings as webSettings } from './web-deploy.fixture.ts';

const scratch = mkdtempSync(join(tmpdir(), 's0-6-release-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const STAMP = 'abcdef012345';
const CANARY = 'release-canary-4b9e';

function webBuild(name: string, stamp: string | null = STAMP): string {
  const dist = join(scratch, name);
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><script src="/assets/a.js"></script>');
  writeFileSync(join(dist, 'assets/a.js'), 'console.log(1);');
  if (stamp !== undefined)
    writeFileSync(join(dist, 'build.json'), JSON.stringify({ build: stamp }));
  return dist;
}

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

/** The release step as a process, with `environment` as its whole environment. */
function releaseProcess(dist: string, out: string, environment: Record<string, string>) {
  return spawnSync(process.execPath, ['scripts/ops/release.ts', '--dist', dist, '--out', out], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...environment },
  });
}

/** Calls the bundled function's GET in a process of its own. */
function callBundled(out: string, settings: Record<string, string>, host: string): string {
  const entry = join(out, 'functions/api.func/index.mjs');
  const script = `const m = await import(${JSON.stringify(entry)});
    try { const r = await m.GET(new Request('https://' + ${JSON.stringify(host)} + '/api/health',
      { headers: { host: ${JSON.stringify(host)} } }));
      console.log('status ' + r.status + ' ' + r.headers.get('cache-control')); }
    catch (error) { console.log('threw ' + error.message); }
    process.exit(0);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...settings },
  });
  return child.stdout.trim();
}

let out = '';

describe('S0-6 the release step writes one build output', () => {
  beforeAll(async () => {
    out = join(scratch, 'out');
    await release({ dist: webBuild('dist'), out });
  }, 120_000);

  outputCase();
  digestCase();
  environmentCase();
  bundledCase();
  deployableCase();
});

function outputCase() {
  it('one Node function in syd1, /api private and no-store, every page static', () => {
    expect(buildOutputProblems(out)).toStrictEqual([]);
    expect(readdirSync(join(out, 'functions'))).toStrictEqual(['api.func']);
    const routes = readJson(join(out, 'config.json'))['routes'] as Record<string, unknown>[];
    expect(routes[0]).toMatchObject({
      src: '^/api(?:/.*)?$',
      headers: { 'cache-control': 'private, no-store' },
      continue: true,
    });
    // Every destination is the API function or a static file the web build wrote.
    const destinations = routes.flatMap((route) =>
      route['dest'] === undefined ? [] : [route['dest']],
    );
    expect(destinations).toStrictEqual(['/api', '/index.html']);
    expect(readFileSync(join(out, 'static/index.html'), 'utf8')).toContain('<!doctype html>');
  });
}

function digestCase() {
  it('records the stamp and a digest the same input repeats and one byte moves', async () => {
    const record = readJson(join(out, 'build.json'));
    expect(record['build']).toBe(STAMP);
    expect(record['digest']).toBe(outputDigest(out));
    const again = join(scratch, 'again');
    await release({ dist: webBuild('dist-again'), out: again });
    expect(readJson(join(again, 'build.json'))['digest']).toBe(record['digest']);
    writeFileSync(join(again, 'static/assets/a.js'), 'console.log(2);');
    expect(outputDigest(again)).not.toBe(record['digest']);
    await expect(release({ dist: webBuild('unstamped', null), out: again })).rejects.toThrow(
      'not stamped',
    );
  }, 120_000);
}

function environmentCase() {
  it('bakes no environment value into the output', () => {
    const canaryOut = join(scratch, 'canary');
    const settings = ['DATABASE_URL', 'DATABASE_LOOKUP_URL', 'GOTRUE_URL', 'SERVED_HOST'];
    const run = releaseProcess(
      webBuild('dist-canary'),
      canaryOut,
      Object.fromEntries(settings.map((name) => [name, `${CANARY}-${name}`])),
    );
    expect(run.status, run.stderr).toBe(0);
    for (const file of readdirSync(canaryOut, { recursive: true, withFileTypes: true })) {
      if (!file.isFile()) continue;
      const text = readFileSync(join(file.parentPath, file.name), 'utf8');
      expect(text.includes(CANARY), join(file.parentPath, file.name)).toBe(false);
    }
  }, 120_000);
}

function bundledCase() {
  it('the function in it is the entry: it names a missing setting and refuses another host', () => {
    expect(callBundled(out, {}, 'ops.example.test')).toBe('threw SERVED_HOST is not set.');
    const settings = {
      DATABASE_URL: 'postgres://app:x@127.0.0.1:1/none',
      DATABASE_LOOKUP_URL: 'postgres://app:x@127.0.0.1:1/none',
      GOTRUE_URL: 'http://127.0.0.1:54391',
      SERVED_HOST: 'ops.example.test',
      DELEGATION_CREDENTIAL_KEY_ID: 'test/release@1',
      DELEGATION_CREDENTIAL_KEYS: `test/release@1:${'k'.repeat(43)}`,
    };
    expect(callBundled(out, settings, 'ops-a1b2c3.vercel.app')).toBe(
      'status 421 private, no-store',
    );
    expect(callBundled(out, settings, 'ops.example.test')).toBe('status 503 private, no-store');
  }, 60_000);
}

function deployableCase() {
  it('the web deploy takes the real release output as stored, only the Vercel CLI faked', async () => {
    const root = mkdtempSync(join(scratch, 'store-'));
    cpSync(out, join(root, artefactName(STAMP)), { recursive: true });
    const vercel = fakeVercel();
    const outcome = await deployWeb(
      { version: STAMP, store: root },
      { env: webSettings(vercel.path), preflight: clean },
    );
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'deployed' });
    expect(vercel.lines('argv')).toContain('deploy --prebuilt --prod');
  }, 60_000);
}
