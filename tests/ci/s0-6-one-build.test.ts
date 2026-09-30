// SPDX-License-Identifier: AGPL-3.0-only
//
// G3, one build for every environment (ticket S0-6; the Vercel re-plan,
// section 5's release row: "no environment value is baked in"). The web build
// promoted from staging to production must not carry staging's addresses, so
// the page reads its sign-in address at run time from the API that checks
// sign-ins, `GET /api/sign-in`, and reaches the API on its own origin. Asked
// of the real web build with both addresses set in the build's environment,
// and of the real function entry.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import { createFunctionHandler } from '../../apps/api/function.ts';
import { TEST_ISSUER } from '../support/sign-in.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 's0-6-one-build-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const HOST = 'ops.example.test';
const ISSUER: string = TEST_ISSUER;
const KEY_ID = 'test/one-build@1';

describe('S0-6 one build serves every environment', () => {
  it('bakes no sign-in or API address into the web build, whatever the build environment says', async () => {
    const canaries = {
      VITE_GOTRUE_URL: 'https://baked-sign-in.example.test',
      VITE_API_ORIGIN: 'https://baked-api.example.test',
    };
    const saved = { ...process.env };
    Object.assign(process.env, canaries);
    const outDir = join(scratch, 'dist');
    try {
      await build({
        configFile: join(root, 'apps', 'web', 'vite.config.ts'),
        logLevel: 'silent',
        build: { outDir, emptyOutDir: true },
      });
    } finally {
      for (const name of Object.keys(canaries)) if (!(name in saved)) delete process.env[name];
    }
    const code = readdirSync(join(outDir, 'assets'))
      .filter((name) => name.endsWith('.js'))
      .map((name) => readFileSync(join(outDir, 'assets', name), 'utf8'))
      .join('\n');
    expect(code.includes('/api/sign-in'), '/api/sign-in').toBe(true);
    for (const baked of [...Object.values(canaries), '127.0.0.1:54391']) {
      expect(code.includes(baked), baked).toBe(false);
    }
  }, 120_000);

  it('the API tells the page its sign-in address, reading nothing and kept by no cache', async () => {
    const handle = createFunctionHandler({
      SERVED_HOST: HOST,
      DATABASE_URL: 'postgres://app:unused@127.0.0.1:1/none',
      DATABASE_LOOKUP_URL: 'postgres://app:unused@127.0.0.1:1/none',
      GOTRUE_URL: ISSUER,
      DELEGATION_CREDENTIAL_KEY_ID: KEY_ID,
      DELEGATION_CREDENTIAL_KEYS: `${KEY_ID}:${randomBytes(32).toString('base64url')}`,
    });
    const answer = await handle(
      new Request(`https://${HOST}/api/sign-in`, { headers: { host: HOST } }),
    );
    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toBe('private, no-store');
    expect(await answer.json()).toStrictEqual({ issuer: ISSUER });
  });
});
