// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's plan sign-in asks OpenAI exactly as its published open-source
// token-sharing flow says (developers.openai.com/siwc/token-sharing-open-source/sign-in):
//
//   - authorize at `/api/accounts/authorize`, first with
//     `client_id=dynamic_agent_client`, the app's `agent_name_hint` and this
//     machine's `ext_agent_host_id` (a `urn:uuid:`, kept for later sign-ins);
//   - the scopes `openid profile email offline_access resource.invoke
//     chatgpt.tokens.use.direct`, `resource=https://api.openai.com/v1`, a
//     fresh `state` and `nonce`, PKCE S256, and a `127.0.0.1` loopback
//     redirect, never `localhost`;
//   - the issued client id comes back on the callback and is the one saved
//     and used: a registration without it is incomplete;
//   - the code is exchanged, form-encoded, at `/api/accounts/oauth/token`
//     with the issued client id, the code, the verifier, the same redirect
//     and the same resource, and the grant must include
//     `chatgpt.tokens.use.direct`;
//   - a later sign-in sends the saved client id and no name hint;
//   - custody's refresh goes to the same token endpoint with the resource.
//
// The issuer is a fake on loopback.

import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { signIn } from '../../apps/model-agent/chatgpt-sign-in.ts';
import { planPresenter } from '../../packages/core-custody/src/plan-present.ts';
import type { StoredCredential } from '../../packages/core-custody/src/index.ts';
import { fake, identity, type Fake, type Heard, type Identity } from './plan-fakes.ts';

const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const RESOURCE = 'https://api.openai.com/v1';
const ISSUED = 'oaiapp_issued_for_this_owner';

let folder: string;
let tokenFile: string;
let issuer: Fake;
let signer: Identity;
/** The nonce the last opened address sent. */
let nonce = '';

/** The issuer's answers: its configuration and keys, and tokens with an ID token for `scope`. */
const granted =
  (scope: string) =>
  (heard: Heard): { status: number; type: string; body: string } =>
    signer.serve(heard) ?? {
      status: 200,
      type: 'application/json',
      body: JSON.stringify({
        access_token: 'access-signed-in-xxxxxxxx',
        refresh_token: 'refresh-signed-in-xxxxxxxx',
        expires_in: 3600,
        scope,
        id_token: signer.idToken({
          iss: issuer.origin,
          aud: ISSUED,
          sub: 'owner-account',
          nonce,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      }),
    };

/** The token endpoint's requests only, in order. */
const exchanges = (): Heard[] =>
  issuer.heard.filter((heard) => heard.path === '/api/accounts/oauth/token');

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'plan-flow-'));
  chmodSync(folder, 0o700);
  tokenFile = join(folder, 'chatgpt-plan.json');
  issuer = await fake();
  signer = identity(issuer.origin);
  issuer.answer = granted(SCOPES);
});

afterEach(async () => {
  await issuer.close();
  rmSync(folder, { recursive: true, force: true });
});

/** Sign in, answering the opened address with the callback query `back` builds. */
async function signedIn(back: (asked: URL) => string) {
  let asked: URL | undefined;
  const result = await signIn({
    issuer: issuer.origin,
    tokenFile,
    port: 0,
    timeoutMs: 5_000,
    say: () => {},
    open: (address) => {
      asked = new URL(address);
      nonce = asked.searchParams.get('nonce') ?? '';
      const to = new URL(asked.searchParams.get('redirect_uri') ?? '');
      void fetch(`${to.origin}${to.pathname}?${back(asked)}`).catch(() => {});
    },
  });
  return { result, asked };
}

const registered = (url: URL): string =>
  `code=c1&state=${url.searchParams.get('state') ?? ''}&client_id=${ISSUED}&scope=${encodeURIComponent(SCOPES)}`;

it('the first sign-in registers at the authorize endpoint with every published parameter', async () => {
  const { asked } = await signedIn(registered);
  expect(asked?.origin).toBe(issuer.origin);
  expect(asked?.pathname).toBe('/api/accounts/authorize');
  const query = asked?.searchParams;
  expect(query?.get('client_id')).toBe('dynamic_agent_client');
  expect(query?.get('agent_name_hint')).toBe('Ops Astro');
  expect(query?.get('ext_agent_host_id')).toMatch(
    /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  expect(query?.get('response_type')).toBe('code');
  expect(query?.get('scope')).toBe(SCOPES);
  expect(query?.get('resource')).toBe(RESOURCE);
  expect(query?.get('code_challenge_method')).toBe('S256');
  expect(query?.get('code_challenge')).toMatch(/^[\w-]{43}$/u);
  expect(query?.get('state')).toMatch(/^[\w-]{32,}$/u);
  expect(query?.get('nonce')).toMatch(/^[\w-]{32,}$/u);
  const back = new URL(query?.get('redirect_uri') ?? '');
  expect(back.protocol).toBe('http:');
  expect(back.hostname).toBe('127.0.0.1');
  expect(back.pathname).toBe('/auth/callback');
});

it('the code is exchanged form-encoded at the token endpoint with the issued id and the resource', async () => {
  const { result, asked } = await signedIn(registered);
  expect(result).toEqual({ ok: true });
  expect(exchanges()).toHaveLength(1);
  const exchange = exchanges()[0];
  expect(exchange?.path).toBe('/api/accounts/oauth/token');
  expect(exchange?.headers['content-type']).toBe('application/x-www-form-urlencoded');
  const form = new URLSearchParams(exchange?.body);
  expect(Object.fromEntries([...form.keys()].map((key) => [key, true]))).toEqual({
    grant_type: true,
    client_id: true,
    code: true,
    code_verifier: true,
    redirect_uri: true,
    resource: true,
  });
  expect(form.get('grant_type')).toBe('authorization_code');
  expect(form.get('client_id')).toBe(ISSUED);
  expect(form.get('code')).toBe('c1');
  expect(form.get('redirect_uri')).toBe(asked?.searchParams.get('redirect_uri'));
  expect(form.get('resource')).toBe(RESOURCE);
  const held = JSON.parse(readFileSync(tokenFile, 'utf8')) as { clientId: string };
  expect(held.clientId).toBe(ISSUED);
  expect(readdirSync(folder).filter((name) => name.endsWith('.next'))).toEqual([]);
  expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
});

it('a registration whose callback carries no issued client id is incomplete, and nothing is exchanged', async () => {
  const { result } = await signedIn(
    (url) => `code=c1&state=${url.searchParams.get('state') ?? ''}`,
  );
  expect(result).toEqual({ ok: false, code: 'SIGN_IN_REGISTRATION_INCOMPLETE' });
  expect(exchanges()).toHaveLength(0);
});

it('a grant without plan use is refused and nothing is written', async () => {
  issuer.answer = granted('openid profile email offline_access');
  const { result } = await signedIn(registered);
  expect(result).toEqual({ ok: false, code: 'SIGN_IN_PLAN_USE_NOT_GRANTED' });
  expect(() => statSync(tokenFile)).toThrow();
});

it('a later sign-in sends the saved client id, no name hint, and the same host id', async () => {
  const first = await signedIn(registered);
  const again = await signedIn((url) => `code=c2&state=${url.searchParams.get('state') ?? ''}`);
  expect(again.result).toEqual({ ok: true });
  expect(again.asked?.searchParams.get('client_id')).toBe(ISSUED);
  expect(again.asked?.searchParams.has('agent_name_hint')).toBe(false);
  expect(again.asked?.searchParams.get('ext_agent_host_id')).toBe(
    first.asked?.searchParams.get('ext_agent_host_id'),
  );
  expect(new URLSearchParams(exchanges()[1]?.body).get('client_id')).toBe(ISSUED);
});

it("custody's refresh goes to the token endpoint, form-encoded, with the issued id and the resource", async () => {
  writeFileSync(
    tokenFile,
    JSON.stringify({
      clientId: ISSUED,
      accessToken: 'access-spent-xxxxxxxx',
      refreshToken: 'refresh-spent-xxxxxxxx',
      expiresAt: Date.now() - 1000,
    }),
    { mode: 0o600 },
  );
  const credential: StoredCredential = {
    ref: 'chatgpt_plan',
    kind: 'subscription',
    account: 'owner-plan',
    destination: 'chatgpt_plan',
    header: 'authorization',
    scheme: 'oauth_refresh',
    value: '',
    tokenFile,
    refreshDestination: 'chatgpt_sign_in',
  };
  const present = planPresenter(
    (key) => (key === 'chatgpt_sign_in' ? issuer.origin : undefined),
    () => {},
  );
  const presented = await present(credential);
  expect(typeof presented).not.toBe('string');
  expect(issuer.heard[0]?.path).toBe('/api/accounts/oauth/token');
  const form = new URLSearchParams(issuer.heard[0]?.body);
  expect(form.get('grant_type')).toBe('refresh_token');
  expect(form.get('client_id')).toBe(ISSUED);
  expect(form.get('refresh_token')).toBe('refresh-spent-xxxxxxxx');
  expect(form.get('resource')).toBe(RESOURCE);
});
