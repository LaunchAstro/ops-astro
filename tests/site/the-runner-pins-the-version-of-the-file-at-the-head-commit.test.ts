// SPDX-License-Identifier: AGPL-3.0-only
//
// #1693 on a real database and a real repository: a request made through the
// door is located by one runner pass through custody against a served source
// host whose answers come from git itself. The agency's About page
// (`fixtures/agency-about/about.astro`) is committed at `src/pages/about.astro`
// in a fresh repository; the served double answers the default branch's head
// with `git rev-parse main` and the file at a commit with its real blob,
// base64 as the provider sends it. The pass pins the correction `requested`
// at that commit, and the digests the test computes from `git show` are the
// ones stored. A sentence of the page is pinned as a phrase the same way
// (#1987).
/* eslint-disable max-lines-per-function -- the pass and what git shows are read in one place */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { locatePass } from '../../apps/site-runner/locate.ts';
import { custodySites, siteDestinations } from '../../apps/site-runner/sites.ts';
import {
  contentDigest,
  versionDigestOf,
  type CorrectionTarget,
} from '../../packages/core-connectors/src/index.ts';
import { startCustody } from '../../packages/core-custody/src/index.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { ASTRO_FILE, ASTRO_PAGE } from './c80-sites.ts';
import { REPOSITORY } from './c80-site-provider.ts';
import { serverUrl, w } from './c80-register-world.ts';
import { noneWaiting, requestOn, rowOf } from './locate-world.ts';
import { configuredSite, useRunnerWorld } from './site-runner-world.ts';

useRunnerWorld();

/** The temp folder and the repository in it, made only when the case runs. */
let folder = '';
let repo = '';

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
const gitBytes = (...args: string[]): Buffer => execFileSync('git', args, { cwd: repo });

/** Every request the served source host was asked, as `METHOD path?query`. */
const asked: string[] = [];
let origin = '';
let server: Server | undefined;

const json = (body: unknown, status = 200) => ({ status, body: JSON.stringify(body) });

/** The source host as GitHub answers these two reads, from the repository itself. */
function answer(method: string, target: string): { status: number; body: string } {
  const url = new URL(target, 'http://source.invalid');
  if (method !== 'GET') return json({ message: 'Not Found' }, 404);
  if (url.pathname === `/repos/${REPOSITORY}/git/ref/heads/main`) {
    const sha = git('rev-parse', 'main').trim();
    return json({ ref: 'refs/heads/main', object: { sha, type: 'commit' } });
  }
  const prefix = `/repos/${REPOSITORY}/contents/`;
  const ref = url.searchParams.get('ref');
  if (!url.pathname.startsWith(prefix) || ref === null) return json({ message: 'Not Found' }, 404);
  const path = decodeURIComponent(url.pathname.slice(prefix.length));
  const blob = git('rev-parse', `${ref}:${path}`).trim();
  // The provider wraps its base64 at 60 characters.
  const content = gitBytes('cat-file', 'blob', blob)
    .toString('base64')
    .replaceAll(/(.{60})/gu, '$1\n');
  return json({ type: 'file', path, sha: blob, size: 1, encoding: 'base64', content });
}

beforeAll(async () => {
  if (serverUrl === undefined) return;
  folder = mkdtempSync(join(tmpdir(), 'site-runner-head-'));
  repo = join(folder, 'site');
  mkdirSync(join(repo, 'src/pages'), { recursive: true });
  copyFileSync(
    new URL('fixtures/agency-about/about.astro', import.meta.url),
    join(repo, ASTRO_FILE),
  );
  git('init', '--quiet', '--initial-branch=main');
  git('add', ASTRO_FILE);
  const who = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com'];
  git(...who, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'About');
  server = createServer((request, response) => {
    request.resume();
    asked.push(`${request.method ?? ''} ${request.url ?? ''}`);
    const { status, body } = answer(request.method ?? '', request.url ?? '/');
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(body);
  });
  const listening = server;
  await new Promise<void>((resolve) => {
    listening.listen(0, '127.0.0.1', () => resolve());
  });
  origin = `http://127.0.0.1:${String((listening.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => {
    if (server === undefined) resolve();
    else server.close(() => resolve());
  });
  if (folder !== '') rmSync(folder, { recursive: true, force: true });
});

/** Custody holding a planted credential for each site entry, both on the served host. */
async function custodyOnServed() {
  const credentialsFile = join(folder, 'credentials.json');
  const entries = (['source_control', 'hosting'] as const).map((ref) => ({
    ref,
    kind: 'api_key',
    account: `${ref}-canary`,
    destination: ref,
    header: 'authorization',
    value: `canary-${randomBytes(12).toString('hex')}`,
  }));
  writeFileSync(credentialsFile, JSON.stringify(entries), { mode: 0o600 });
  return await startCustody({
    credentialsFile,
    destinations: siteDestinations({ source: origin, hosting: origin }, false),
  });
}

/** One locate pass through custody against the served source host. */
async function locateOnServed() {
  const custody = await custodyOnServed();
  try {
    const site = configuredSite();
    const ports = custodySites(
      {
        custody,
        resolve: () => Promise.resolve(['140.82.112.6']),
        capture: {
          pool: { agencyPages: [], otherPages: [], closedPoolReviews: [] },
          resolve: () => Promise.resolve(['93.184.216.34']),
          transport: () => Promise.resolve({ kind: 'failed' }),
        },
        wait: () => Promise.resolve(),
        now: Date.now,
      },
      site,
    ).locate();
    const business = w.world.business as BusinessId;
    return await locatePass({ db: w.world.db.app, business, site, ports });
  } finally {
    await custody.stop();
  }
}

/** The version digest the locate must store for `target` changed in the file at `head`. */
async function expectPinned(id: string, target: CorrectionTarget, from: string, to: string) {
  const head = git('rev-parse', 'main').trim();
  const before = git('show', `main:${ASTRO_FILE}`);
  const after = before.replace(from, to);
  expect(after).not.toBe(before);
  const [{ seam } = { seam: '' }] = await w.world.db.admin.execute<{ readonly seam: string }>(
    'select seam from public.live_corrections where id = $1',
    [id],
  );
  const preImageDigest = contentDigest(before);
  const row = await rowOf(id);
  expect(row).toMatchObject({
    state: 'requested',
    base_revision: head,
    pre_image_digest: preImageDigest,
    version_digest: versionDigestOf({
      target,
      change: { files: [{ path: ASTRO_FILE, before, after }] },
      preImageDigest,
      baseRevision: head,
      pageUrl: ASTRO_PAGE,
      seam,
    }),
    check_failures: 0,
  });
  expect(row.version_id).toMatch(/^[0-9a-f-]{36}$/u);
  expect(row.verified_at).not.toBeNull();
}

describe.skipIf(serverUrl === undefined)(
  'the runner pins the version of the file at the head commit',
  () => {
    it('pins a request from the real blob at the default branch head, its digests as git shows them', async () => {
      await noneWaiting();
      const target = { path: ASTRO_FILE, word: 'alongside', replacement: 'beside' };
      const id = await requestOn(ASTRO_PAGE, {
        word: target.word,
        replacement: target.replacement,
      });
      expect(await locateOnServed()).toEqual([{ correctionId: id, outcome: 'requested' }]);

      const head = git('rev-parse', 'main').trim();
      expect(asked).toEqual([
        `GET /repos/${REPOSITORY}/git/ref/heads/main`,
        `GET /repos/${REPOSITORY}/contents/src/pages/about.astro?ref=${head}`,
      ]);
      const before = git('show', `main:${ASTRO_FILE}`);
      const after = before.replace('walk alongside you', 'walk beside you');
      expect(after).not.toBe(before);
      const [{ seam } = { seam: '' }] = await w.world.db.admin.execute<{ readonly seam: string }>(
        'select seam from public.live_corrections where id = $1',
        [id],
      );
      const preImageDigest = contentDigest(before);
      const row = await rowOf(id);
      expect(row).toMatchObject({
        state: 'requested',
        base_revision: head,
        pre_image_digest: preImageDigest,
        version_digest: versionDigestOf({
          target,
          change: { files: [{ path: ASTRO_FILE, before, after }] },
          preImageDigest,
          baseRevision: head,
          pageUrl: ASTRO_PAGE,
          seam,
        }),
        check_failures: 0,
      });
      expect(row.version_id).toMatch(/^[0-9a-f-]{36}$/u);
      expect(row.verified_at).not.toBeNull();
    });

    it('pins a sentence of the About page as a phrase, at the head, its digests as git shows them', async () => {
      await noneWaiting();
      const word = 'We exist to chart the course';
      const replacement = 'We are here to chart the course';
      const id = await requestOn(ASTRO_PAGE, { word, replacement });
      expect(await locateOnServed()).toEqual([{ correctionId: id, outcome: 'requested' }]);
      await expectPinned(id, { path: ASTRO_FILE, word, replacement }, word, replacement);
    });
  },
);
