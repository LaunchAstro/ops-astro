// SPDX-License-Identifier: AGPL-3.0-only
//
// Only an HS256 bearer for `aud` authenticated and this deployment's `iss` is
// admitted, or answered AUTH_SESSION_EXPIRED. hono is a runtime dependency past
// the 4.10.7 advisories; `pnpm audit` itself runs as a check on the pull request.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sign } from 'hono/jwt';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { executeAgentCommand } from '../../packages/core-records/src/commands/agent-envelope.ts';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';

const SECRET = 'a-local-test-secret-for-cq-1-sign-in';
const ISSUER = 'http://127.0.0.1:54391';
const api = createApi({
  database: { withBusiness: () => Promise.reject(new Error('entered')) } as unknown as Database,
  verify: createSupabaseVerifier({ secret: SECRET, issuer: ISSUER }),
  resolveBusiness: () => Promise.resolve('11111111-1111-4111-8111-111111111111'),
  executeCommand,
  executeRead,
  executeAgentCommand,
});

const now = () => Math.floor(Date.now() / 1000);
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const GOTRUE = { sub: 'mia', aud: 'authenticated', iss: ISSUER };
const claims = (over: object = {}) => ({ ...GOTRUE, iat: now(), exp: now() + 600, ...over });
const PAST = { exp: now() - 60 };
const NO = 'AUTH_UNKNOWN_LOGIN';

async function swapped(): Promise<string> {
  const [header, , signature] = (await sign(claims(PAST), SECRET)).split('.');
  return `${header}.${b64(claims({ ...PAST, sub: 'eve' }))}.${signature}`;
}

const CASES: readonly (readonly [string, () => Promise<string>, string])[] = [
  ['CQ-1 audience refused: another', () => sign(claims({ aud: 'anon' }), SECRET), NO],
  ['CQ-1 audience refused: none', () => sign(claims({ aud: undefined }), SECRET), NO],
  ['CQ-1 issuer refused: another', () => sign(claims({ iss: `${ISSUER}/` }), SECRET), NO],
  ['CQ-1 issuer refused: none', () => sign(claims({ iss: undefined }), SECRET), NO],
  ['CQ-1 algorithm refused: none', async () => `${b64({ alg: 'none' })}.${b64(claims())}.`, NO],
  ['CQ-1 algorithm refused: HS512', () => sign(claims(), SECRET, 'HS512'), NO],
  ['CQ-1 future nbf refused', () => sign(claims({ nbf: now() + 600 }), SECRET), NO],
  ['CQ-1 expired still expired', () => sign(claims(PAST), SECRET), 'AUTH_SESSION_EXPIRED'],
  ['CQ-1 forged expired: another secret', () => sign(claims(PAST), 'another'), NO],
  ['CQ-1 forged expired: payload swapped', swapped, NO],
  ['CQ-1 forged expired: another audience', () => sign(claims({ ...PAST, aud: 'x' }), SECRET), NO],
  ['CQ-1 forged expired: another issuer', () => sign(claims({ ...PAST, iss: 'x' }), SECRET), NO],
];

describe('CQ-1 sign-in claims', () => {
  for (const path of ['/api/b/alpha/task/create', '/api/a/b/alpha/task/queue']) {
    for (const [name, token, code] of CASES) {
      it(`${name} (${path})`, async () => {
        const headers = { authorization: `Bearer ${await token()}` };
        const response = await api.fetch(
          new Request(`http://api.test${path}`, { method: 'POST', body: '{}', headers }),
        );
        expect(((await response.json()) as Record<string, unknown>)['code']).toBe(code);
      });
    }
  }
});

const read = (path: string) => readFileSync(join(import.meta.dirname, '../..', path), 'utf8');

describe('CQ-1 runtime deps', () => {
  const pkg = JSON.parse(read('package.json')) as Record<string, Record<string, string>>;
  const hono = pkg['dependencies']?.['hono'] ?? '';

  it('CQ-1 runtime deps: hono and @hono/node-server are runtime, pinned and recorded', () => {
    for (const name of ['hono', '@hono/node-server']) {
      const row = new RegExp(`\\| \`${name}\` +\\| ${pkg['dependencies']?.[name]} +\\|`, 'u');
      expect(pkg['devDependencies']?.[name]).toBeUndefined();
      expect(read('docs/supply-chain-pins.md')).toMatch(row);
    }
  });

  it('CQ-1 audit clean: one hono in the lockfile, at or past 4.13.5, which fixes them all', () => {
    const locked = read('pnpm-lock.yaml').matchAll(/^ {2}hono@([\d.]+):/gmu);
    expect(new Set([...locked].map((match) => match[1]))).toStrictEqual(new Set([hono]));
    expect(hono.localeCompare('4.13.5', 'en', { numeric: true })).toBeGreaterThanOrEqual(0);
  });
});
