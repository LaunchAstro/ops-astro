// SPDX-License-Identifier: AGPL-3.0-only
//
// The LaunchAstro GitHub App on the M5 (#1793): `load-app` files the App's
// private key as the site's `source_control` entry from standard input, and
// `bind` gives a party its one site repository and the installation on it. A
// party reaches one repository, and a repository belongs to one party. With
// the App bound, the read-only smoke reads the About page through a token
// minted for it. The key appears in the credential file and nowhere else.

import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadSiteEntry, smokeSite } from '../../scripts/m5/site-custody.ts';

const SCRIPT = join(import.meta.dirname, '../../scripts/m5/site-custody.ts');
const ENV = { PATH: process.env['PATH'] ?? '' };
const KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const AGENCY = {
  party: 'party-agency',
  repository: 'LaunchAstro/agency-astro-astro',
  installation: '71',
};

let folder: string;
let file: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'm5-site-app-'));
  file = join(folder, 'site.json');
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

function run(args: readonly string[], input = '') {
  const result = spawnSync(process.execPath, [SCRIPT, ...args, '--file', file], {
    input,
    env: ENV,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const loadApp = (key = KEY) => run(['load-app', '--app-id', '424242'], `${key}\n`);
const bind = (binding: Record<string, string>) =>
  run([
    'bind',
    '--party',
    binding['party']!,
    '--repository',
    binding['repository']!,
    '--installation',
    binding['installation']!,
  ]);
const keyBody = KEY.split('\n')[1] ?? KEY;

it('loads the App key once into an owner-only file, never echoing it', () => {
  const first = loadApp();
  expect(first).toMatchObject({ status: 0 });
  expect(first.output).toMatch(/source_control loaded and read back/u);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([
    {
      ref: 'source_control',
      kind: 'api_key',
      account: 'github-app-424242',
      destination: 'source_control',
      header: 'authorization',
      scheme: 'github_app',
      app: { id: '424242', bindings: [] },
      value: KEY,
    },
  ]);
  expect(loadApp().output).toMatch(/already loaded/u);
  expect(first.output.includes(keyBody)).toBe(false);
  expect(readdirSync(folder)).toEqual(['site.json']);
});

it('refuses a value that is no RSA private key, and writes nothing', () => {
  const value = `canary-${randomBytes(18).toString('hex')}`;
  const refused = loadApp(value);
  expect(refused.status).toBe(1);
  expect(refused.output).toMatch(/CREDENTIAL_MALFORMED/u);
  expect(refused.output.includes(value)).toBe(false);
  expect(readdirSync(folder)).toEqual([]);
});

it('binds a party to one repository, once; neither a party nor a repository is bound twice', () => {
  expect(bind(AGENCY).output).toMatch(/APP_NOT_LOADED/u);
  loadApp();
  expect(bind(AGENCY)).toMatchObject({ status: 0 });
  expect(bind(AGENCY).output).toMatch(/already bound/u);
  const before = readFileSync(file, 'utf8');
  for (const [other, code] of [
    [{ ...AGENCY, repository: 'LaunchAstro/other-site' }, 'PARTY_ALREADY_BOUND'],
    [{ ...AGENCY, party: 'party-client' }, 'REPOSITORY_ALREADY_BOUND'],
    [{ ...AGENCY, party: 'party-client', repository: 'Client/../x' }, 'CREDENTIAL_MALFORMED'],
    [
      { ...AGENCY, party: 'party-client', repository: 'Client/site', installation: '0' },
      'CREDENTIAL_MALFORMED',
    ],
  ] as const) {
    const refused = bind(other);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain(code);
  }
  expect(readFileSync(file, 'utf8')).toBe(before);
  const [entry] = JSON.parse(before) as { app: { bindings: unknown[] } }[];
  expect(entry?.app.bindings).toEqual([{ ...AGENCY, installation: 71 }]);
});

/** GitHub's App token endpoint, the repository and the hosting project, on one local origin. */
async function standIn(seen: string[]): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const url = request.url ?? '';
      seen.push(`${request.method ?? ''} ${url.split('?')[0] ?? ''}`);
      const body = url.startsWith('/app/')
        ? {
            token: 'ghs_minted0001',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            repositories: [{ full_name: AGENCY.repository }],
          }
        : url.startsWith('/repos/')
          ? { sha: 'b10b', content: Buffer.from('About').toString('base64'), encoding: 'base64' }
          : { id: 'prj_1', targets: { production: { id: 'dpl_1' } } };
      response
        .writeHead(url.startsWith('/app/') ? 201 : 200, { 'content-type': 'application/json' })
        .end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
  return { origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, close };
}

it('the smoke reads the About page with a token minted for the bound party, and with no party sends nothing to the repository', async () => {
  const seen: string[] = [];
  const { origin, close } = await standIn(seen);
  try {
    loadApp();
    bind(AGENCY);
    expect(loadSiteEntry(file, 'hosting', `canary-${randomBytes(18).toString('hex')}`)).toBe(
      'loaded',
    );
    const options = {
      origins: { source_control: origin, hosting: origin },
      resolve: () => Promise.resolve(['76.76.21.21']),
    };
    expect((await smokeSite(file, options)).lines[0]).toBe(
      'site.source.read refused CUSTODY_REPOSITORY_NOT_BOUND',
    );
    expect(seen.filter((one) => !one.startsWith('GET /v9'))).toEqual([]);
    seen.length = 0;
    const result = await smokeSite(file, { ...options, party: AGENCY.party });
    expect(result).toEqual({
      ok: true,
      lines: ['site.source.read ok', 'site.deployment.current ok'],
    });
    expect(seen.slice(0, 2)).toEqual([
      'POST /app/installations/71/access_tokens',
      'GET /repos/LaunchAstro/agency-astro-astro/contents/src/pages/about.astro',
    ]);
  } finally {
    await close();
  }
});
