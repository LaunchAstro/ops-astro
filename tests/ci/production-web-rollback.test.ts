// SPDX-License-Identifier: AGPL-3.0-only
//
// Production's recorded rollback (#2299): `web-deploy.mjs --rollback
// <deployment> --production` puts production back on a deployment its web
// deploy recorded, by Vercel's instant rollback, so the old build keeps the
// settings it was made with and nothing is built again with today's. After a
// recorded rollback Vercel gives a new deployment no domain until one is
// promoted, so production's next deploy promotes itself and the maintenance
// page waits for it. `vercel` is the fixture's fake; nothing reaches Vercel.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { recordedStamp } from '../../scripts/ops/build-output.ts';
import { artefactName } from '../../scripts/ops/promotion.ts';
import { deployMaintenance, deployWeb } from '../../scripts/ops/web-deploy.ts';
import { rollBackWeb } from '../../scripts/ops/web-rollback.ts';
import { each, records } from './promotion.fixture.ts';
import { AUTH_VERSION, CANARY, clean, fakeVercel, INSPECTED } from './web-deploy.fixture.ts';
import { settings, STAGED, store, URL_MADE } from './web-deploy.fixture.ts';
import { join } from 'node:path';

const DECISION = 'DECISIONS 33, owner 2026-10-28';
const REF = 'zyxwvutsrqzyxwvutsrq';
const POOLER = 'aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres?sslmode=require';
const OLDER = 'bbf67ef13a85';
const EARLIER = 'https://ops-astro-production-iuspjm793-agency-astro.vercel.app';
beforeEach(() => {
  vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ version: AUTH_VERSION })));
});
afterEach(() => vi.unstubAllGlobals());

const production = (path: string): Record<string, string> => ({
  ...settings(path),
  STAGING_PROJECT_REF: 'abcdefghijabcdefghij',
  PRODUCTION_PROJECT_REF: REF,
  DATABASE_ADMIN_URL: `postgresql://postgres.${REF}:${CANARY}@${POOLER}`,
  GOTRUE_URL: `https://${REF}.supabase.co/auth/v1`,
});
const held = async <T>(work: () => Promise<T>): Promise<T> => await work();
const revoked = (): Promise<never> => Promise.reject(new Error('the grant was revoked'));
const deployed = (environment: string, version: string, deployment: string): object => ({
  action: 'deploy recorded',
  environment,
  version,
  deployment,
});
const rolledBack = (version: string, deployment: string): object => ({
  action: 'rollback recorded',
  environment: 'production',
  version,
  deployment,
});
/** Vercel's read-back of `deployment`, as `vercel inspect --format json` prints it. */
const inspected = (deployment: string, more: object = {}) => ({
  out: JSON.stringify({ ...INSPECTED, url: deployment.slice('https://'.length), ...more }),
  status: 0,
});
const refused = (why: string) => ({ kind: 'refused', reason: expect.stringContaining(why) });

it('rolls production back to a deployment its deploy recorded, building nothing', async () => {
  const at = records([
    deployed('production', OLDER, EARLIER),
    deployed('production', STAGED, URL_MADE),
  ]);
  const vercel = fakeVercel({ inspect: inspected(EARLIER) });
  const outcome = await rollBackWeb(EARLIER, {
    env: production(vercel.path),
    records: at,
    authorised: held,
  });
  expect(outcome).toStrictEqual({
    kind: 'deployed',
    record: {
      action: 'rollback recorded',
      environment: 'production',
      version: OLDER,
      deployment: EARLIER,
    },
  });
  expect(vercel.lines('argv')).toStrictEqual([
    `inspect ${EARLIER} --format json`,
    `rollback ${EARLIER} --timeout 3m`,
  ]);
  const env = vercel.lines('env').join('\n');
  expect(env).not.toContain(CANARY);
  expect(env).not.toMatch(/VERCEL_TOKEN|DATABASE/u);
});

it('refuses a deployment production never recorded, asking Vercel nothing', async () => {
  const cases: [(string | object)[], string][] = [
    [[], `records no production deploy at ${EARLIER}`],
    [[deployed('staging', OLDER, EARLIER)], `records no production deploy at ${EARLIER}`],
    [[{ action: 'maintenance recorded', deployment: EARLIER }], 'records no production deploy'],
    [[deployed('production', OLDER, URL_MADE)], 'records no production deploy'],
    [['not json', deployed('production', OLDER, EARLIER)], 'is not a record'],
  ];
  await each(cases, async ([lines, why]) => {
    const vercel = fakeVercel({ inspect: inspected(EARLIER) });
    const outcome = await rollBackWeb(EARLIER, {
      env: production(vercel.path),
      records: records(lines),
      authorised: held,
    });
    expect(outcome).toMatchObject(refused(why));
    expect(vercel.lines('argv')).toStrictEqual([]);
  });
}, 30_000);

it("refuses a deployment Vercel does not report ready on production: it would build it again with today's settings", async () => {
  const at = records([deployed('production', OLDER, EARLIER)]);
  const answers = [
    inspected(EARLIER, { target: null }),
    inspected(EARLIER, { readyState: 'ERROR' }),
    inspected(URL_MADE),
    { out: '', status: 1 },
  ];
  await each(answers, async (inspect) => {
    const vercel = fakeVercel({ inspect });
    const outcome = await rollBackWeb(EARLIER, {
      env: production(vercel.path),
      records: at,
      authorised: held,
    });
    expect(outcome).toMatchObject(refused('not ready on production'));
    expect(vercel.lines('argv')).toStrictEqual([`inspect ${EARLIER} --format json`]);
  });
}, 30_000);

it('a rollback Vercel does not finish is a failure, not a record', async () => {
  const at = records([deployed('production', OLDER, EARLIER)]);
  const vercel = fakeVercel({ inspect: inspected(EARLIER), rollback: { out: '', status: 1 } });
  const outcome = await rollBackWeb(EARLIER, {
    env: production(vercel.path),
    records: at,
    authorised: held,
  });
  expect(outcome).toMatchObject({
    kind: 'failed',
    reason: expect.stringContaining('rollback status'),
  });
});

it('asks Vercel nothing when the held grant refuses, or the settings are unusable', async () => {
  const at = records([deployed('production', OLDER, EARLIER)]);
  const vercel = fakeVercel({ inspect: inspected(EARLIER) });
  const env = production(vercel.path);
  const outcomes = [
    await rollBackWeb(EARLIER, { env, records: at, authorised: revoked }),
    await rollBackWeb(EARLIER, {
      env: { ...env, VERCEL_TOKEN: CANARY },
      records: at,
      authorised: held,
    }),
  ];
  expect(outcomes).toMatchObject([
    refused('the grant was revoked'),
    refused('VERCEL_TOKEN is set'),
  ]);
  expect(JSON.stringify(outcomes)).not.toContain(CANARY);
  expect(vercel.lines('argv')).toStrictEqual([]);
});

/** Production's deploy of STAGED, released, onto the record folder holding `before`. */
async function deployAfter(before: object[], promote?: { out: string; status: number }) {
  const root = store();
  const digest = String(recordedStamp(join(root, artefactName(STAGED))).digest);
  const at = records([{ action: 'release recorded', version: STAGED, digest }, ...before]);
  const vercel = fakeVercel({ promote });
  const request = { version: STAGED, store: root };
  const options = {
    env: production(vercel.path),
    preflight: clean,
    environment: 'production' as const,
    records: at,
    authorised: held,
    stagingOff: DECISION,
  };
  const outcome = await deployWeb(request, options);
  return { outcome, argv: vercel.lines('argv') };
}

it('the next production deploy after a recorded rollback promotes itself; others do not', async () => {
  const back = [deployed('production', STAGED, URL_MADE), rolledBack(OLDER, EARLIER)];
  const after = await deployAfter(back);
  expect(after.outcome).toMatchObject({ kind: 'deployed', record: { deployment: URL_MADE } });
  expect(after.argv.at(-1)).toBe(`promote ${URL_MADE} --timeout 3m`);
  const settled = await deployAfter([...back, deployed('production', STAGED, URL_MADE)]);
  const never = await deployAfter([deployed('production', OLDER, EARLIER)]);
  for (const { outcome, argv } of [settled, never]) {
    expect(outcome.kind).toBe('deployed');
    expect(argv.filter((line) => line.startsWith('promote'))).toStrictEqual([]);
  }
}, 30_000);

it('a promotion Vercel does not finish leaves the deploy unrecorded', async () => {
  const back = [deployed('production', OLDER, EARLIER), rolledBack(OLDER, EARLIER)];
  const { outcome } = await deployAfter(back, { out: '', status: 1 });
  expect(outcome).toMatchObject({
    kind: 'failed',
    reason: expect.stringContaining(`vercel promote ${URL_MADE}`),
  });
}, 30_000);

it('the maintenance page waits for the deploy that promotes after a recorded rollback', async () => {
  const vercel = fakeVercel();
  const env = production(vercel.path);
  const back = records([deployed('production', OLDER, EARLIER), rolledBack(OLDER, EARLIER)]);
  const page = await deployMaintenance({ env, rolledBackIn: back });
  expect(page).toMatchObject(refused('rolled back'));
  expect(vercel.lines('argv')).toStrictEqual([]);
  const settled = records([rolledBack(OLDER, EARLIER), deployed('production', STAGED, URL_MADE)]);
  expect(await deployMaintenance({ env, rolledBackIn: settled })).toMatchObject({
    kind: 'deployed',
  });
}, 30_000);
