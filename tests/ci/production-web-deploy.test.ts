// SPDX-License-Identifier: AGPL-3.0-only
//
// The web deploy to production (`web-deploy.mjs --production`). It keeps every
// check staging's deploy makes (the settings, the stored output and its digest,
// the sign-in server's version, Vercel's read-back) except the made-up-only
// preflight, which a database holding real sign-ins can never pass. In its
// place: the database and sign-in addresses must be production's project and
// not staging's, and production's own preflight must find no sign that the
// made-up seed ran there. `vercel` is the fixture's fake (web-deploy.fixture.ts)
// and the hosted sign-in server's health page is answered in this process.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { preflightFor, productionPreflight, stagingSigns } from '../../scripts/ops/deploy.ts';
import { artefactName } from '../../scripts/ops/promotion.ts';
import { deployWeb } from '../../scripts/ops/web-deploy.ts';
import {
  AUTH_VERSION,
  CANARY,
  clean,
  fakeVercel,
  settings,
  STAGED,
  store,
  URL_MADE,
} from './web-deploy.fixture.ts';

const STAGING = 'abcdefghijabcdefghij';
const PRODUCTION = 'zyxwvutsrqzyxwvutsrq';
const POOLER = 'aws-0-ap-southeast-2.pooler.supabase.com';
const signIn = (ref: string): string => `https://${ref}.supabase.co/auth/v1`;
const database = (ref: string): string =>
  `postgresql://postgres.${ref}:${CANARY}@${POOLER}:5432/postgres?sslmode=require`;

const production = (path: string, overrides: Record<string, string | undefined> = {}) => ({
  ...settings(path),
  STAGING_PROJECT_REF: STAGING,
  PRODUCTION_PROJECT_REF: PRODUCTION,
  DATABASE_ADMIN_URL: database(PRODUCTION),
  GOTRUE_URL: signIn(PRODUCTION),
  ...overrides,
});

const asked: string[] = [];
beforeEach(() => {
  asked.length = 0;
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
    const address = String(input);
    asked.push(address);
    if (address === `${signIn(PRODUCTION)}/health` || address === `${signIn(STAGING)}/health`) {
      return Promise.resolve(Response.json({ version: AUTH_VERSION, name: 'GoTrue' }));
    }
    return real(input, init);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('production web deploy: recorded as staging is, on production', () => {
  it('deploys a database holding real sign-ins once production’s own preflight finds no made-up sign', async () => {
    const vercel = fakeVercel();
    const preflight = vi.fn(clean);
    const outcome = await deployWeb(
      { version: STAGED, store: store() },
      { env: production(vercel.path), preflight, environment: 'production' },
    );
    expect(preflight).toHaveBeenCalledOnce();
    expect(outcome.kind).toBe('deployed');
    if (outcome.kind !== 'deployed') return;
    expect(outcome.record).toMatchObject({
      action: 'deploy recorded',
      environment: 'production',
      version: STAGED,
      artefact: artefactName(STAGED),
      deployment: URL_MADE,
      authVersion: AUTH_VERSION,
    });
    expect(asked).toStrictEqual([`${signIn(PRODUCTION)}/health`]);
    expect(vercel.lines('argv')).toStrictEqual([
      'deploy --prebuilt --prod',
      `inspect ${URL_MADE} --format json`,
    ]);
    expect(JSON.stringify(outcome)).not.toContain(CANARY);
  });

  it('a staging deploy records its own environment', async () => {
    const vercel = fakeVercel();
    const outcome = await deployWeb(
      { version: STAGED, store: store() },
      { env: settings(vercel.path), preflight: clean },
    );
    expect(outcome.kind === 'deployed' && outcome.record.environment).toBe('staging');
  });
});

/** Refused with `reason`, Vercel never asked. */
const refusedWith = async (
  overrides: Record<string, string | undefined>,
  reason: string,
  preflight = clean,
) => {
  const vercel = fakeVercel();
  const outcome = await deployWeb(
    { version: STAGED, store: store() },
    { env: production(vercel.path, overrides), preflight, environment: 'production' },
  );
  expect(outcome).toStrictEqual({ kind: 'refused', reason: `${reason}. Nothing was deployed.` });
  expect(vercel.lines('argv')).toStrictEqual([]);
};

describe("production web deploy: refused off production's project, before Vercel is asked", () => {
  it("refuses staging's database or sign-in address", async () => {
    await refusedWith(
      { DATABASE_ADMIN_URL: database(STAGING) },
      "DATABASE_ADMIN_URL reaches staging's project",
    );
    await refusedWith({ GOTRUE_URL: signIn(STAGING) }, "GOTRUE_URL is not production's sign-in");
  });

  it("refuses another project's addresses, a loopback sign-in, or a missing reference", async () => {
    const other = 'qqqqqqqqqqqqqqqqqqqq';
    await refusedWith(
      { DATABASE_ADMIN_URL: database(other) },
      "DATABASE_ADMIN_URL is not production's project",
    );
    await refusedWith({ GOTRUE_URL: signIn(other) }, "GOTRUE_URL is not production's sign-in");
    await refusedWith(
      { GOTRUE_URL: 'http://127.0.0.1:9999/auth/v1' },
      "GOTRUE_URL is not production's sign-in",
    );
    await refusedWith({ STAGING_PROJECT_REF: undefined }, 'STAGING_PROJECT_REF is not set');
    await refusedWith({ PRODUCTION_PROJECT_REF: STAGING }, "PRODUCTION_PROJECT_REF is staging's");
  });

  it("refuses on production's preflight signs, naming production", async () => {
    await refusedWith(
      {},
      "production's database failed the preflight: it carries the made-up mark",
      () => Promise.resolve(['it carries the made-up mark']),
    );
  });

  it("still refuses Vercel's token, as staging's deploy does", async () => {
    await refusedWith(
      { VERCEL_TOKEN: CANARY },
      "VERCEL_TOKEN is set: the deploy runs under the person's own sign-in only",
    );
  });
});

describe('production web deploy: each environment its own preflight', () => {
  it("production takes production's preflight; staging keeps made-up-only", () => {
    expect(preflightFor('production')).toBe(productionPreflight);
    expect(preflightFor('staging')).toBe(stagingSigns);
  });
});
