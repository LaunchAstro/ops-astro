// SPDX-License-Identifier: AGPL-3.0-only
//
// The restore drill's sign-in, end to end. Once the operator's login has a
// verified authenticator, the operator gate (`requireOperatingOperator`, the
// drill's first step) refuses the token a password alone gives, and admits the
// very token `pnpm cli login --second-factor` saved: the bytes are read back
// from the file and checked as the gate checks any bearer, against the key set
// on loopback and the real database. The account route the code goes through
// is the real API's; only the sign-in provider is a stand-in, signing as
// GoTrue does, and it signs only what its own routes issue.

import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { createGoTrueFactors } from '../../apps/api/auth/factors.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { main as cli } from '../../apps/cli/main.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { requireOperatingOperator } from '../../scripts/ops/operator.ts';
import {
  ACCEPTANCE_ISSUER,
  bearer,
  call,
  createWorld,
  personPath,
  serverUrl,
  type World,
} from '../acceptance/world.ts';
import {
  serveTestKeySetApart,
  signBearer,
  testSignIn,
  type ServedKeySet,
} from '../support/sign-in.ts';

const PASSWORD = 'gate-password-canary-0b7e';
const CODE = '135790';
const SESSION = randomUUID();

let world: World;
let keySet: ServedKeySet;
let provider: Server;
let app: ReturnType<typeof createApi>;
let api: ServerType;
let apiUrl = '';
let providerUrl = '';
let folder: string;

const now = (): number => Math.floor(Date.now() / 1000);

/** A bearer for the one provider session, as GoTrue signs it. */
const signed = async (aal: 'aal1' | 'aal2'): Promise<string> =>
  await signBearer({
    sub: world.ada.subject,
    aud: 'authenticated',
    role: 'authenticated',
    iss: ACCEPTANCE_ISSUER,
    exp: now() + 600,
    aal,
    session_id: SESSION,
    // Signed in just after now, so no ending earlier in this second reaches it.
    amr: [
      { method: 'password', timestamp: now() + 1 },
      ...(aal === 'aal2' ? [{ method: 'totp', timestamp: now() }] : []),
    ],
  });

/** The provider's routes this sign-in uses; anything else is a 404. */
async function answer(route: string, body: string): Promise<{ status: number; body?: unknown }> {
  if (route === 'POST /token?grant_type=password') {
    return {
      status: 200,
      body: { access_token: await signed('aal1'), token_type: 'bearer', expires_in: 3600 },
    };
  }
  if (route === 'POST /factors') {
    return {
      status: 200,
      body: {
        id: 'factor-one',
        type: 'totp',
        totp: { qr_code: 'data:,x', secret: 'S', uri: 'otpauth://totp/x' },
      },
    };
  }
  if (route === 'POST /factors/factor-one/challenge')
    return { status: 200, body: { id: 'challenge-one', type: 'totp' } };
  if (route === 'POST /factors/factor-one/verify') {
    const good = (JSON.parse(body) as { code?: unknown }).code === CODE;
    return good
      ? {
          status: 200,
          body: { access_token: await signed('aal2'), refresh_token: 'refresh', expires_in: 3600 },
        }
      : {
          status: 422,
          body: { code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' },
        };
  }
  if (route.startsWith('POST /logout')) return { status: 204 };
  return { status: 404, body: { msg: 'no such route' } };
}

beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await createWorld('sfgate');
  // alpha operates the installation (migration 0045), as provisioning writes it.
  await world.db.admin.execute(
    'insert into ops.operating_business (operating_business) values ($1)',
    [world.alpha],
  );
  keySet = await serveTestKeySetApart();
  provider = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      void (async () => {
        const reply = await answer(`${request.method ?? ''} ${request.url ?? ''}`, body);
        response.writeHead(reply.status, { 'content-type': 'application/json' });
        response.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
      })();
    });
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  providerUrl = `http://127.0.0.1:${String((provider.address() as AddressInfo).port)}`;
  app = createApi({
    database: world.db.app,
    verify: createSupabaseVerifier(testSignIn(ACCEPTANCE_ISSUER)),
    resolveBusiness: async (key: string) =>
      await Promise.resolve({ alpha: world.alpha, bravo: world.bravo }[key]),
    executeCommand,
    executeRead,
    executeAgentCommand,
    factors: createGoTrueFactors({ baseUrl: providerUrl, timeoutMs: 2_000 }),
  });
  // The API's own Response stays global: its provider calls check `instanceof Response`.
  api = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0, overrideGlobalObjects: false });
  await once(api, 'listening');
  apiUrl = `http://127.0.0.1:${String((api.address() as AddressInfo).port)}`;
  folder = mkdtempSync(join(tmpdir(), 'cli-login-gate-'));
}, 60_000);

afterAll(async () => {
  if (serverUrl === undefined) return;
  api?.close();
  provider?.closeAllConnections();
  provider?.close();
  await keySet?.close();
  await world?.close();
  rmSync(folder, { recursive: true, force: true });
});

/** The drill's settings, as the gate reads them, with `token` as the bearer. */
function drillSettings(token: string): Record<string, string> {
  const admin = new URL(serverUrl as string);
  admin.pathname = `/${world.db.name}`;
  return {
    OPS_ASTRO_TOKEN: token,
    OPS_ASTRO_BUSINESS: 'alpha',
    OPS_ASTRO_DEPLOYMENTS: join(folder, 'records'),
    DATABASE_URL: world.db.appUrl,
    DATABASE_ADMIN_URL: admin.toString(),
    GOTRUE_URL: ACCEPTANCE_ISSUER,
    SUPABASE_KEY_SET_URL: keySet.url,
  };
}

/** `pnpm cli login`, the token file's bytes after it, and what it printed. */
async function login(name: string, secondFactor: boolean) {
  const printed: string[] = [];
  const io = {
    out: (line: string) => printed.push(line),
    err: (line: string) => printed.push(line),
    stdin: async () => await Promise.resolve(`${CODE}\n`),
  };
  const tokenFile = join(folder, name);
  const code = await cli(
    ['login', '--email', 'operator@example.test', ...(secondFactor ? ['--second-factor'] : [])],
    {
      OPS_ASTRO_GOTRUE_URL: providerUrl,
      OPS_ASTRO_API_URL: apiUrl,
      OPS_ASTRO_BUSINESS: 'alpha',
      OPS_ASTRO_PASSWORD: PASSWORD,
      OPS_ASTRO_TOKEN_FILE: tokenFile,
    },
    io,
  );
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
  return { code, printed: printed.join('\n'), token };
}

describe.skipIf(serverUrl === undefined)('the drill sign-in steps up to the operator gate', () => {
  it('admits the password-only token while the login has no authenticator', async () => {
    const plain = await login('before-enrolment', false);
    expect(plain.code).toBe(0);
    const gate = await requireOperatingOperator(drillSettings(plain.token));
    expect(gate.ok && gate.operator.personId).toBe(world.ada.personId);
  });

  it('once the authenticator is verified, refuses the password-only token and admits the saved stepped-up one', async () => {
    const first = await signed('aal1');
    const enrolled = await call(
      app,
      personPath('alpha', '/account/factor/enrol'),
      {},
      bearer(first),
    );
    expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(200);
    const verified = await call(
      app,
      personPath('alpha', '/account/factor/verify'),
      { code: CODE },
      bearer(first),
    );
    expect(verified.status).toBe(200);

    const plain = await login('password-only', false);
    expect(plain.code).toBe(0);
    const refused = await requireOperatingOperator(drillSettings(plain.token));
    expect(refused.ok).toBe(false);
    // Refused for the factor, not for an ended session: the API names it.
    const asked = await call(
      app,
      personPath('alpha', '/session/capabilities'),
      {},
      bearer(plain.token),
    );
    expect(asked.code).toBe('AUTH_SECOND_FACTOR_REQUIRED');

    const stepped = await login('stepped-up', true);
    expect(stepped.code).toBe(0);
    expect(stepped.token).not.toBe(plain.token);
    for (const secret of [stepped.token, plain.token, PASSWORD, CODE]) {
      expect(stepped.printed.includes(secret)).toBe(false);
    }
    const admitted = await requireOperatingOperator(drillSettings(stepped.token));
    expect(admitted.ok && admitted.operator.personId).toBe(world.ada.personId);
  });
});
