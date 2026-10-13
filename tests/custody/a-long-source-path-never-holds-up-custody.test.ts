// SPDX-License-Identifier: AGPL-3.0-only
//
// Route matching takes time in proportion to the path and never recurses: a
// caller's long source path cannot hold custody's one message loop past its
// deadline, and a long template custody admits at load matches its own path.
// A path over the request cap is refused before any route is matched.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  parseExtras,
  pathAllowed,
  templateFilled,
} from '../../packages/core-custody/src/egress-routes.ts';
import { siteDestination, startCustody } from '../../packages/core-custody/src/index.ts';

type Custody = Awaited<ReturnType<typeof startCustody>>;

/** A source provider on loopback and a custody holding its key, stopped and removed after `run`. */
async function withSourceCustody(run: (custody: Custody) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"sha":"abc","content":"PHA+","encoding":"base64"}');
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const folder = mkdtempSync(join(tmpdir(), 'route-liveness-'));
  const credentialsFile = join(folder, 'credentials.json');
  writeFileSync(
    credentialsFile,
    JSON.stringify([
      {
        ref: 'source_control',
        kind: 'api_key',
        account: 'proof',
        destination: 'source_control',
        header: 'authorization',
        value: randomBytes(24).toString('hex'),
      },
    ]),
    { mode: 0o600 },
  );
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const custody = await startCustody({
    credentialsFile,
    destinations: [siteDestination('source_control', origin)],
  });
  try {
    await run(custody);
  } finally {
    await custody.stop();
    rmSync(folder, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

it('a source path cannot block custody from describing another call', async () => {
  await withSourceCustody(async (custody) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const base = {
        destination: 'source_control',
        method: 'GET' as const,
        body: '',
        timeoutMs: 500,
        maxResponseBytes: 1024,
      };
      // The actual catalogue route and a real provider response work first.
      expect(
        await custody.dispatch('source_control', {
          ...base,
          path: '/repos/agency/site/contents/about.astro?ref=main',
        }),
      ).toMatchObject({ kind: 'answered', outbound: { ok: true } });
      expect(await custody.describe('source_control', 'source_control')).toMatchObject({
        account: 'proof',
        presents: true,
      });

      // Custody's IPC boundary accepts this 64 KiB path without a token.
      const dispatch = custody.dispatch('source_control', {
        ...base,
        path: '/repos/agency/site/contents/' + 'a/'.repeat(32_000) + 'a?ref=main',
      });
      const described = await Promise.race([
        custody.describe('source_control', 'source_control'),
        new Promise<'blocked'>((resolve) => {
          timer = setTimeout(() => resolve('blocked'), 1500);
        }),
      ]);
      // Stop even a stuck matcher before asserting, leaving no child process.
      custody.kill();
      await dispatch;
      expect(
        described,
        'a 500 ms source read blocked all custody messages for 1500 ms',
      ).toMatchObject({
        account: 'proof',
        presents: true,
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  });
}, 10_000);

it('an admitted literal template cannot overflow the route matcher', () => {
  const path = '/a'.repeat(10_000);
  const extras = parseExtras({
    routes: [{ method: 'GET', template: path, fields: { id: 'string' } }],
  });
  expect(extras).toBeDefined();
  expect(() => templateFilled(extras ?? {}, 'GET', path)).not.toThrow();
  expect(templateFilled(extras ?? {}, 'GET', path)?.template).toBe(path);
});

const SOURCE = parseExtras({
  routes: [
    {
      method: 'GET',
      template: '/repos/{repository*}/contents/{path*}?ref={ref}',
      fields: { sha: 'string' },
    },
  ],
});

it('refuses a path over 8 KiB before matching any route', () => {
  const fits = `/repos/agency/site/contents/${'a/'.repeat(4_000)}a?ref=main`;
  const over = `/repos/agency/site/contents/${'a/'.repeat(4_100)}a?ref=main`;
  expect(fits.length).toBeLessThanOrEqual(8_192);
  expect(over.length).toBeGreaterThan(8_192);
  expect(pathAllowed(SOURCE ?? {}, 'GET', fits)).toBe(true);
  expect(pathAllowed(SOURCE ?? {}, 'GET', over)).toBe(false);
});

it('fills two many-segment slots only with one plain segment or more each', () => {
  const filled = (path: string) => templateFilled(SOURCE ?? {}, 'GET', path) !== undefined;
  expect(filled('/repos/agency/site/contents/about.astro?ref=main')).toBe(true);
  expect(filled('/repos/agency/contents/site/contents/a/b.md?ref=main')).toBe(true);
  expect(filled('/repos/agency/site/contents/contents?ref=main')).toBe(true);
  expect(filled('/repos/contents/about.astro?ref=main')).toBe(false);
  expect(filled('/repos/agency/site/contents?ref=main')).toBe(false);
  expect(filled('/repos/agency/site/about.astro?ref=main')).toBe(false);
  expect(filled('/repos/agency/site/contents/a//b?ref=main')).toBe(false);
  expect(filled('/repos/agency/../contents/a?ref=main')).toBe(false);
  expect(filled('/repos/agency/site/contents/a/?ref=main')).toBe(false);
  expect(filled('repos/agency/site/contents/a?ref=main')).toBe(false);
});
