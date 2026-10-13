// SPDX-License-Identifier: AGPL-3.0-only
//
// Under a preset, `login` asks the app's own origin where to sign in
// (`GET <origin>/api/sign-in`, as the web does) and sends the password only to
// that issuer, over https, with that key. A redirect is never followed: the
// stand-in fetch follows one unless told `redirect: 'manual'`, so a second
// origin that hears nothing proves the policy, not only the URL.

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ISSUER, KEY, run, SANDBOX, standIn, type Route, type Seen } from './preset-stand-in.ts';

const PASSWORD = 'discovery-password-canary-41c9';
const ELSEWHERE = 'https://elsewhere.example.test';

let folder: string;
let env: Record<string, string>;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cli-preset-login-'));
  env = { OPS_ASTRO_TOKEN_FILE: join(folder, 'token'), OPS_ASTRO_PASSWORD: PASSWORD };
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(folder, { recursive: true, force: true });
});

async function login(route?: Route): Promise<{ code: number; err: string; seen: Seen[] }> {
  const stand = standIn(route);
  vi.stubGlobal('fetch', stand.fetch);
  const { code, out, err } = await run(
    ['login', '--env', 'sandbox', '--email', 'a@example.test'],
    env,
  );
  return { code, err: `${out}\n${err}`, seen: stand.seen };
}

const signInAddress =
  (answer: Response): Route =>
  (url) =>
    url.origin === SANDBOX && url.pathname === '/api/sign-in' ? answer : undefined;

describe('login under a preset reads the sign-in address from the app', () => {
  it('the grant goes to the issuer the app named, with its key, and the token is saved', async () => {
    const { code, err, seen } = await login();
    expect(code, err).toBe(0);
    const grant = seen.find((one) => one.url.startsWith(ISSUER[SANDBOX] ?? '-'));
    expect(grant?.url).toBe(`${ISSUER[SANDBOX]}/token?grant_type=password`);
    expect(grant?.headers['apikey']).toBe(KEY[SANDBOX]);
    expect(seen.filter((one) => one.body.includes(PASSWORD))).toStrictEqual([grant]);
    expect(existsSync(join(folder, 'token.sandbox'))).toBe(true);
  });

  const failures: readonly (readonly [string, () => Response])[] = [
    [
      'a redirect to another origin',
      () => new Response(null, { status: 307, headers: { location: `${ELSEWHERE}/api/sign-in` } }),
    ],
    ['an http issuer', () => Response.json({ issuer: 'http://plain.example.test/auth/v1' })],
    ['a 500', () => new Response('down', { status: 500 })],
    ['no issuer', () => Response.json({ key: 'sb_publishable_x' })],
  ];

  failures.forEach(([what, answer]) => {
    it(`${what}: exit 1, no grant, nothing saved, nothing sent elsewhere`, async () => {
      const elsewhere: Route = (url) =>
        url.origin === ELSEWHERE
          ? Response.json({ issuer: `${ELSEWHERE}/auth/v1`, key: 'sb_publishable_elsewhere' })
          : undefined;
      const answered = signInAddress(answer());
      const { code, err, seen } = await login(
        async (url, one) => (await answered(url, one)) ?? elsewhere(url, one),
      );
      expect(code).toBe(1);
      expect(err).toContain(`could not read the sign-in address from ${SANDBOX}`);
      expect(seen.map((one) => one.url)).toStrictEqual([`${SANDBOX}/api/sign-in`]);
      expect(seen[0]?.redirect).toBe('manual');
      expect(readdirSync(folder)).toStrictEqual([]);
      expect(err).not.toContain(PASSWORD);
    });
  });
});
