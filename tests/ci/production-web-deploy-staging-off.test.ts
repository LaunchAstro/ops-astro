// SPDX-License-Identifier: AGPL-3.0-only
//
// Production's web deploy with staging off by the owner's decision (#2285):
// `--staging-off <reference>`, production's alone, takes the digest the
// release step recorded for the version in the operator's record folder in
// place of staging's, under every other check. Without it every refusal of
// #970 stands. `vercel` is the fixture's fake; the sign-in server's health
// page is answered in this process.

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordedStamp } from '../../scripts/ops/build-output.ts';
import { artefactName } from '../../scripts/ops/promotion.ts';
import { deployMaintenance, deployWeb } from '../../scripts/ops/web-deploy.ts';
import { each, records, replaced, stagingLine } from './promotion.fixture.ts';
import { AUTH_VERSION, CANARY, clean, fakeVercel, folder } from './web-deploy.fixture.ts';
import { OUTPUT, settings, STAGED, store } from './web-deploy.fixture.ts';

const DECISION = 'DECISIONS 33, owner 2026-10-28';
const OTHER = `sha256:${'0'.repeat(64)}`;
const REF = 'zyxwvutsrqzyxwvutsrq';
const POOLER = 'aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres?sslmode=require';
beforeEach(() => {
  vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ version: AUTH_VERSION })));
});
afterEach(() => vi.unstubAllGlobals());

const releaseLine = (version: string, digest: string): object => ({
  action: 'release recorded',
  version,
  digest,
});
const digestOf = (root: string): string =>
  String(recordedStamp(join(root, artefactName(STAGED))).digest);
/** A store holding STAGED and a record folder holding its release line, then `more`. */
const released = (more: object[] = []): [string, string] => {
  const root = store();
  return [root, records([releaseLine(STAGED, digestOf(root)), ...more])];
};

/** Production's deploy and planned page for STAGED from `root` with the record folder `at`. */
async function deploy(root: string, at: string, extra?: object) {
  const vercel = fakeVercel();
  const env = {
    ...settings(vercel.path),
    STAGING_PROJECT_REF: 'abcdefghijabcdefghij',
    PRODUCTION_PROJECT_REF: REF,
    DATABASE_ADMIN_URL: `postgresql://postgres.${REF}:${CANARY}@${POOLER}`,
    GOTRUE_URL: `https://${REF}.supabase.co/auth/v1`,
  };
  const request = { version: STAGED, store: root };
  const options = {
    env,
    preflight: clean,
    environment: 'production' as const,
    records: at,
    authorised: async <T>(work: () => Promise<T>): Promise<T> => await work(),
    stagingOff: DECISION,
    ...extra,
  };
  const outcome = await deployWeb(request, options);
  const page = await deployMaintenance({ env }, { request, options });
  return { outcome, page, argv: vercel.lines('argv') };
}
const refused = (why: string) => ({ kind: 'refused', reason: expect.stringContaining(why) });

it('deploys the bytes the release recorded, naming the waiver and the decision', async () => {
  const [root, at] = released();
  const { outcome, page, argv } = await deploy(root, at);
  const record = { digest: digestOf(root), stagingRecord: 'waived', waivedBy: DECISION };
  expect(outcome).toMatchObject({ kind: 'deployed', record });
  expect(page).toMatchObject({ kind: 'deployed', record: { action: 'maintenance recorded' } });
  expect(argv.filter((line) => line.startsWith('deploy'))).toHaveLength(2);
});

it('without --staging-off a release record alone is refused as before', async () => {
  const [root, at] = released();
  const { outcome, page, argv } = await deploy(root, at, { stagingOff: undefined });
  expect(outcome).toMatchObject(refused(`staging has no record of deploying ${STAGED}`));
  expect(page).toMatchObject({ kind: 'refused' });
  expect(argv).toStrictEqual([]);
});

it('refuses no release record, two release digests and a tree stored since', async () => {
  const root = store();
  const swapped = released();
  replaced(swapped[0], OUTPUT);
  const cases: [string, string, string][] = [
    [root, records([stagingLine(STAGED, digestOf(root))]), 'the release step has no record of'],
    [...released([releaseLine(STAGED, OTHER)]), 'disagree on its digest'],
    [...swapped, 'is not the bytes the release step recorded'],
  ];
  await each(cases, async ([from, at, why]) => {
    const { outcome, page, argv } = await deploy(from, at);
    expect(outcome).toMatchObject(refused(why));
    expect(page).toMatchObject({ kind: 'refused' });
    expect(argv).toStrictEqual([]);
  });
});

it('judges the release record again after the preflight wait', async () => {
  const [root, at] = released();
  const preflight = (): Promise<string[]> => {
    const line = JSON.stringify(releaseLine(STAGED, OTHER));
    appendFileSync(join(at, 'deployments.jsonl'), `${line}\n`);
    return clean();
  };
  const { outcome, argv } = await deploy(root, at, { preflight });
  expect(outcome).toMatchObject(refused('the release record changed before the deploy'));
  expect(argv).toStrictEqual([]);
});

it('refuses --staging-off off production, and a reference that is not one short line', async () => {
  const [root, at] = released();
  const staging = await deploy(root, at, { environment: 'staging' });
  expect(staging.outcome).toMatchObject(refused('--staging-off is for a production deploy alone'));
  await each(['', 'two\nlines', 'x'.repeat(101)], async (stagingOff) => {
    const { outcome } = await deploy(root, at, { stagingOff });
    expect(outcome).toMatchObject(refused("--staging-off names the owner's decision"));
  });
});

it('the release step records its version and digest; production deploys that output', async () => {
  const dist = folder('dist');
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Ops Astro</title>');
  writeFileSync(join(dist, 'build.json'), JSON.stringify({ build: STAGED }));
  const root = folder('released');
  const at = records([]);
  const out = join(root, artefactName(STAGED));
  const run = spawnSync(
    process.execPath,
    ['scripts/ops/release.ts', '--dist', dist, '--out', out],
    {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', OPS_ASTRO_DEPLOYMENTS: at },
    },
  );
  expect(run.status, run.stderr).toBe(0);
  const lines = readFileSync(join(at, 'deployments.jsonl'), 'utf8').split('\n').filter(Boolean);
  expect(lines.map((line) => JSON.parse(line) as object)).toMatchObject([
    { action: 'release recorded', version: STAGED, digest: digestOf(root) },
  ]);
  expect((await deploy(root, at)).outcome.kind).toBe('deployed');
}, 60_000);
