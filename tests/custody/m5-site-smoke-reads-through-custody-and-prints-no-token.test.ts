// SPDX-License-Identifier: AGPL-3.0-only
//
// The read-only smoke of the agency site's custody entries (#1691): with the
// two entries loaded, custody's own process reads the About page's source and
// the project's current production deployment, and nothing else. The smoke
// sends two GETs, each with its own entry's token, and its lines never carry
// a token or the page's text, even when the provider echoes the token back.
// A credential file others can read is refused before custody starts. A
// local stand-in answers in place of both providers.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { loadSiteEntry, smokeSite } from '../../scripts/m5/site-custody.ts';

const tokens = {
  source_control: `canary-${randomBytes(18).toString('hex')}`,
  hosting: `canary-${randomBytes(18).toString('hex')}`,
};
const PAGE = 'walk alongside you';
const seen: { method: string; url: string; authorization: string | undefined }[] = [];
let echoing = false;
let server: Server;
let folder: string;
let file: string;
let origin: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const authorization = request.headers.authorization;
      seen.push({ method: request.method ?? '', url: request.url ?? '', authorization });
      const token = (authorization ?? '').replace('Bearer ', '');
      const body = (request.url ?? '').startsWith('/repos/')
        ? { sha: 'b10b', content: Buffer.from(PAGE).toString('base64'), encoding: 'base64' }
        : { id: 'prj_1', targets: { production: { id: echoing ? `dpl_${token}` : 'dpl_1' } } };
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  folder = mkdtempSync(join(tmpdir(), 'm5-site-smoke-'));
  file = join(folder, 'credentials.json');
  expect(loadSiteEntry(file, 'source_control', tokens.source_control)).toBe('loaded');
  expect(loadSiteEntry(file, 'hosting', tokens.hosting)).toBe('loaded');
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server?.closeAllConnections();
    server?.close(() => resolve());
  });
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
  echoing = false;
  chmodSync(file, 0o600);
});

const smoke = () =>
  smokeSite(file, {
    origins: { source_control: origin, hosting: origin },
    resolve: () => Promise.resolve(['76.76.21.21']),
  });

it('reads the About source and the current deployment through custody, two GETs, each with its own token', async () => {
  const result = await smoke();
  expect(result.ok).toBe(true);
  expect(result.lines).toEqual(['site.source.read ok', 'site.deployment.current ok']);
  expect(seen).toEqual([
    {
      method: 'GET',
      url: '/repos/LaunchAstro/agency-astro-astro/contents/src/pages/about.astro?ref=main',
      authorization: `Bearer ${tokens.source_control}`,
    },
    {
      method: 'GET',
      url: '/v9/projects/prj_ZP8jeokQCN6SJsyuzkz4ISihdlHm',
      authorization: `Bearer ${tokens.hosting}`,
    },
  ]);
  const printed = result.lines.join('\n');
  for (const value of [...Object.values(tokens), PAGE]) expect(printed.includes(value)).toBe(false);
});

it('fails on a provider that echoes the token, and prints no token', async () => {
  echoing = true;
  const result = await smoke();
  expect(result.ok).toBe(false);
  expect(result.lines).toEqual([
    'site.source.read ok',
    'site.deployment.current refused PROVIDER_CREDENTIAL_ECHOED',
  ]);
  for (const value of Object.values(tokens)) expect(result.lines.join('\n')).not.toContain(value);
});

it('refuses a credential file others can read before custody starts, and sends nothing', async () => {
  chmodSync(file, 0o640);
  const result = await smoke();
  expect(result).toEqual({ ok: false, lines: ['refused LOAD_FILE_NOT_OWNER_ONLY'] });
  expect(seen).toEqual([]);
});

it('takes no origin from its command line, so a token cannot be sent elsewhere', () => {
  const script = join(import.meta.dirname, '../../scripts/m5/site-custody.ts');
  const run = spawnSync(process.execPath, [script, 'smoke', '--file', file, '--origin', origin], {
    env: { PATH: process.env['PATH'] ?? '' },
    encoding: 'utf8',
  });
  expect(run.status).toBe(1);
  expect(run.stderr).toMatch(/usage/u);
  expect(seen).toEqual([]);
});
