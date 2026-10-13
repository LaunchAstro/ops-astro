// SPDX-License-Identifier: AGPL-3.0-only
//
// `pnpm cli login --second-factor`: the password grant, then the person's
// authenticator code checked on their own account route, the one the web's
// code step uses (`account/factor/verify`). Only the token that route answers
// is saved, owner-only and never printed. Any refusal saves nothing, ends the
// half-made sign-in on the account route, and names the route's refusal code
// alone. The code is read from stdin or a hidden prompt, never from a flag or
// the environment. The sign-in service and the API are stand-ins on loopback.

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { main as cli } from '../../apps/cli/main.ts';
import { standInGoTrue, type StandIn } from '../support/stand-in-gotrue.ts';

const PASSWORD = 'second-factor-password-canary-3e1d';
const FIRST = 'password-only-token-canary-90ab';
const STEPPED = 'stepped-up-token-canary-55f2';
const CODE = '246810';

let gotrue: StandIn;
let api: Server;
let apiUrl = '';
let folder: string;
/** What the stand-in API saw: route, bearer and body. */
let seen: { route: string; bearer: string | undefined; body: string }[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(async () => {
  gotrue = await standInGoTrue({
    issue: async () => await Promise.resolve(FIRST),
    expiresIn: 3_600,
  });
  api = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      const route = `${request.method ?? ''} ${request.url ?? ''}`;
      seen.push({ route, bearer: request.headers.authorization, body });
      const verify = route === 'POST /api/b/alpha/account/factor/verify';
      const reply = verify ? answer : { status: 200, body: { ended: true } };
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => {
    api.listen(0, '127.0.0.1', resolve);
  });
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  folder = mkdtempSync(join(tmpdir(), 'cli-login-second-factor-'));
});

beforeEach(() => {
  seen = [];
  answer = { status: 200, body: { accessToken: STEPPED, otherSessions: 0 } };
});

afterAll(async () => {
  await gotrue?.close();
  api?.closeAllConnections();
  await new Promise<void>((resolve) => {
    api?.close(() => resolve());
  });
  rmSync(folder, { recursive: true, force: true });
});

async function login(
  name: string,
  {
    args = [],
    env = {},
    stdin = `${CODE}\n`,
  }: { args?: string[]; env?: Record<string, string>; stdin?: string } = {},
) {
  const printed: string[] = [];
  const io = {
    out: (line: string) => printed.push(line),
    err: (line: string) => printed.push(line),
    stdin: async () => await Promise.resolve(stdin),
  };
  const tokenFile = join(folder, name);
  const code = await cli(
    ['login', '--email', 'operator@example.test', '--second-factor', ...args],
    {
      OPS_ASTRO_GOTRUE_URL: gotrue.url,
      OPS_ASTRO_API_URL: apiUrl,
      OPS_ASTRO_BUSINESS: 'alpha',
      OPS_ASTRO_PASSWORD: PASSWORD,
      OPS_ASTRO_TOKEN_FILE: tokenFile,
      ...env,
    },
    io,
  );
  return { code, printed: printed.join('\n'), tokenFile };
}

const saved = (file: string): string | undefined => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

const noSecretIn = (printed: string): void => {
  for (const secret of [PASSWORD, FIRST, STEPPED, CODE])
    expect(printed.includes(secret)).toBe(false);
};

describe('cli login --second-factor', () => {
  it('saves the stepped-up token the account route answers, owner-only, and prints none', async () => {
    const { code, printed, tokenFile } = await login('good');

    expect(code).toBe(0);
    expect(saved(tokenFile)).toBe(`${STEPPED}\n`);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(seen).toEqual([
      {
        route: 'POST /api/b/alpha/account/factor/verify',
        bearer: `Bearer ${FIRST}`,
        body: JSON.stringify({ code: CODE }),
      },
    ]);
    expect(JSON.parse(printed)).toEqual({ ok: true, saved: tokenFile });
    noSecretIn(printed);
  });

  it('reads the code from the line after the password when both come on stdin', async () => {
    const { code, tokenFile } = await login('both-on-stdin', {
      env: { OPS_ASTRO_PASSWORD: '' },
      stdin: `${PASSWORD}\n${CODE}\n`,
    });

    expect(code).toBe(0);
    expect(saved(tokenFile)).toBe(`${STEPPED}\n`);
    expect(seen[0]?.body).toBe(JSON.stringify({ code: CODE }));
  });
});

describe('cli login --second-factor, refused', () => {
  it.each([
    ['a wrong code', 422, 'FACTOR_CODE_INVALID'],
    ['a login with no authenticator', 409, 'FACTOR_NOT_ENROLLED'],
  ])(
    '%s saves nothing, ends the half sign-in and names the refusal',
    async (_, status, refusal) => {
      answer = { status, body: { refused: true, code: refusal, fixes: [] } };
      const { code, printed, tokenFile } = await login(`refused-${refusal}`);

      expect(code).toBe(1);
      expect(saved(tokenFile)).toBeUndefined();
      expect(printed).toContain(refusal);
      expect(seen.map((call) => [call.route, call.bearer, call.body])).toEqual([
        [
          'POST /api/b/alpha/account/factor/verify',
          `Bearer ${FIRST}`,
          JSON.stringify({ code: CODE }),
        ],
        ['POST /api/b/alpha/account/sessions/sign-out', `Bearer ${FIRST}`, '{}'],
      ]);
      noSecretIn(printed);
    },
  );

  it('an answer with no token saves nothing and ends the half sign-in', async () => {
    answer = { status: 200, body: { otherSessions: 0 } };
    const { code, tokenFile } = await login('tokenless');

    expect(code).not.toBe(0);
    expect(saved(tokenFile)).toBeUndefined();
    expect(seen.at(-1)?.route).toBe('POST /api/b/alpha/account/sessions/sign-out');
  });
});

describe('cli login --second-factor reads the code from stdin alone', () => {
  it('takes no code as a flag', async () => {
    const { code, tokenFile } = await login('flagged', { args: ['--code', CODE] });

    expect(code).toBe(2);
    expect(saved(tokenFile)).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('takes no code from the environment', async () => {
    const { code, tokenFile } = await login('from-env', {
      env: { OPS_ASTRO_CODE: CODE, OPS_ASTRO_SECOND_FACTOR_CODE: CODE },
      stdin: '',
    });

    expect(code).toBe(2);
    expect(saved(tokenFile)).toBeUndefined();
    expect(seen).toEqual([]);
  });
});
