// SPDX-License-Identifier: AGPL-3.0-only
//
// #970, the production web deploy (`web-deploy.mjs --production`), the live
// path to production: Vercel is handed only the bytes staging ran. The
// stored output's digest must be the one staging's web deploy recorded for the
// version in the operator's record folder; it is judged at selection, again
// after the preflight and the sign-in server's health read, as the last step
// before Vercel is asked, and once more before the deploy is recorded. The
// deploy runs only under the operator's held grant (`authorised`). `vercel`
// is the fixture's fake (web-deploy.fixture.ts); promotion-staged-digest.test.ts
// holds the record's own rules.

import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deployWeb } from '../../scripts/ops/web-deploy.ts';
import { each, replaced, scratch, staged, stagingLine, STAGED } from './promotion.fixture.ts';
import {
  AUTH_VERSION,
  CANARY,
  clean,
  fakeVercel,
  OUTPUT,
  settings,
  store,
} from './web-deploy.fixture.ts';

const PRODUCTION = 'zyxwvutsrqzyxwvutsrq';
const POOLER = 'aws-0-ap-southeast-2.pooler.supabase.com';
const OTHER_DIGEST = `sha256:${'2'.repeat(64)}`;
const production = (path: string) => ({
  ...settings(path),
  STAGING_PROJECT_REF: 'abcdefghijabcdefghij',
  PRODUCTION_PROJECT_REF: PRODUCTION,
  DATABASE_ADMIN_URL: `postgresql://postgres.${PRODUCTION}:${CANARY}@${POOLER}:5432/postgres?sslmode=require`,
  GOTRUE_URL: `https://${PRODUCTION}.supabase.co/auth/v1`,
});
const admitted = async <T>(work: () => Promise<T>): Promise<T> => await work();
const refusing = (): Promise<never> =>
  Promise.reject(new Error('the operator no longer holds operations:manage'));
const line = (entry: object | string): string =>
  `${typeof entry === 'string' ? entry : JSON.stringify(entry)}\n`;

beforeEach(() => {
  vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ version: AUTH_VERSION })));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A production deploy of `root` against `records`, with `preflight` and `authorised` as given. */
const deploy = async (
  root: string,
  records: string | undefined,
  path: string,
  extra: {
    preflight?: () => Promise<string[]>;
    authorised?: typeof admitted | null | undefined;
  } = {},
) =>
  await deployWeb(
    { version: STAGED, store: root },
    {
      env: production(path),
      preflight: extra.preflight ?? clean,
      environment: 'production',
      ...(records === undefined ? {} : { records }),
      ...(extra.authorised === null ? {} : { authorised: extra.authorised ?? admitted }),
    },
  );

describe('the production web deploy selects only the bytes staging ran', () => {
  it('deploys what staging recorded, and refuses a restamped tree before the database or Vercel is asked', async () => {
    const root = store();
    const recorded = staged(root);
    expect((await deploy(root, recorded, fakeVercel().path)).kind).toBe('deployed');

    replaced(root, OUTPUT);
    const vercel = fakeVercel();
    const preflight = vi.fn(clean);
    const outcome = await deploy(root, recorded, vercel.path, { preflight });
    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: expect.stringMatching(/is not the bytes staging ran/u),
    });
    expect(preflight).not.toHaveBeenCalled();
    expect(vercel.lines('argv')).toStrictEqual([]);
  });

  it('refuses production with no record folder named, or with no held grant to run under', async () => {
    const root = store();
    const cases = [
      [undefined, undefined, /staging's record folder/u],
      [staged(root), null, /held grant/u],
    ] as const;
    await each(cases, async ([records, authorised, reason]) => {
      const vercel = fakeVercel();
      const outcome = await deploy(root, records, vercel.path, { authorised });
      expect(outcome).toMatchObject({ kind: 'refused', reason: expect.stringMatching(reason) });
      expect(vercel.lines('argv')).toStrictEqual([]);
    });
  });

  it('staging’s own deploy needs no staging record: it is the one that makes it', async () => {
    const vercel = fakeVercel();
    const outcome = await deployWeb(
      { version: STAGED, store: store() },
      { env: settings(vercel.path), preflight: clean },
    );
    expect(outcome.kind).toBe('deployed');
  });
});

describe('the production web deploy judges staging’s record again after its waits', () => {
  it('a conflicting or torn line appended during the preflight refuses before Vercel is asked', async () => {
    await each([stagingLine(STAGED, OTHER_DIGEST), '{"torn'], async (appended) => {
      const root = store();
      const folder = staged(root);
      const vercel = fakeVercel();
      const preflight = async (): Promise<string[]> => {
        appendFileSync(join(folder, 'deployments.jsonl'), line(appended));
        return await clean();
      };
      const outcome = await deploy(root, folder, vercel.path, { preflight });
      expect(outcome).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/staging/u) });
      expect(vercel.lines('argv')).toStrictEqual([]);
    });
  });

  it('an unrelated line appended during the preflight still deploys', async () => {
    const root = store();
    const folder = staged(root);
    const preflight = async (): Promise<string[]> => {
      appendFileSync(
        join(folder, 'deployments.jsonl'),
        line(stagingLine('fedcba987654', OTHER_DIGEST)),
      );
      return await clean();
    };
    expect((await deploy(root, folder, fakeVercel().path, { preflight })).kind).toBe('deployed');
  });
});

describe('the production web deploy acts only while staging’s record and the operator still hold', () => {
  it('a conflicting line appended while Vercel deploys fails the deploy unrecorded', async () => {
    const root = store();
    const folder = staged(root);
    const vercel = fakeVercel();
    // A `vercel` ahead of the fake that appends staging's conflicting line as it deploys.
    const bin = join(scratch, `appending-${String(Date.now())}`);
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'vercel'),
      [
        '#!/bin/sh',
        `if [ "$1" = deploy ]; then printf '%s\\n' '${JSON.stringify(stagingLine(STAGED, OTHER_DIGEST))}' >> '${join(folder, 'deployments.jsonl')}'; fi`,
        `exec '${join(vercel.path.split(':')[0]!, 'vercel')}' "$@"`,
      ].join('\n'),
    );
    chmodSync(join(bin, 'vercel'), 0o755);
    const outcome = await deploy(root, folder, `${bin}:${vercel.path}`);
    expect(vercel.lines('argv')[0]).toBe('deploy --prebuilt --prod');
    expect(outcome).toMatchObject({
      kind: 'failed',
      reason: expect.stringMatching(/changed during the deploy/u),
    });
  });

  it('asks Vercel nothing once the operator is no longer admitted', async () => {
    const root = store();
    const vercel = fakeVercel();
    const outcome = await deploy(root, staged(root), vercel.path, { authorised: refusing });
    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: expect.stringMatching(/no longer holds operations:manage/u),
    });
    expect(vercel.lines('argv')).toStrictEqual([]);
  });
});
