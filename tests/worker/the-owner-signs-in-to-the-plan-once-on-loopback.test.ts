// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's one sign-in to the ChatGPT plan on the owner's machine (#1620):
// the loopback PKCE flow, whose published request shape the open-source flow
// test holds. Here: a wrong state is refused and nothing is exchanged; a
// declined sign-in is refused by name; the code is exchanged with the
// verifier that matches the challenge; and the tokens land in custody's file,
// owner-only, with nothing secret said on the way. The issuer is a fake on
// loopback.

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { signIn } from '../../apps/model-agent/chatgpt-sign-in.ts';
import { fake, identity } from './plan-fakes.ts';

interface Issuer {
  readonly origin: string;
  /** The token endpoint's requests, as forms. */
  readonly exchanges: URLSearchParams[];
  close(): Promise<void>;
}

const ACCESS = 'access-signed-in-xxxxxxxx';
const REFRESH = 'refresh-signed-in-xxxxxxxx';
/** The nonce the last opened address sent. */
let nonce = '';

/** A fake issuer answering with its key set and tokens holding a signed ID token. */
async function fakeIssuer(): Promise<Issuer> {
  const endpoint = await fake();
  const signer = identity(endpoint.origin);
  endpoint.answer = (heard) =>
    signer.serve(heard) ?? {
      status: 200,
      type: 'application/json',
      body: JSON.stringify({
        access_token: ACCESS,
        refresh_token: REFRESH,
        expires_in: 3600,
        scope: 'openid offline_access resource.invoke chatgpt.tokens.use.direct',
        id_token: signer.idToken({
          iss: endpoint.origin,
          aud: 'oaiapp_fake_client',
          sub: 'owner-account',
          nonce,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      }),
    };
  return {
    origin: endpoint.origin,
    get exchanges() {
      return endpoint.heard
        .filter((heard) => heard.path === '/api/accounts/oauth/token')
        .map((heard) => new URLSearchParams(heard.body));
    },
    close: endpoint.close,
  };
}

let folder: string;
let issuer: Issuer;

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'plan-sign-in-'));
  issuer = await fakeIssuer();
});

afterEach(async () => {
  await issuer.close();
  rmSync(folder, { recursive: true, force: true });
});

/** Sign in, answering the opened address with `answer`'s callback query. */
async function signedIn(answer: (asked: URL) => string) {
  const said: string[] = [];
  const tokenFile = join(folder, 'chatgpt-plan.json');
  let asked: URL | undefined;
  const result = await signIn({
    issuer: issuer.origin,
    tokenFile,
    port: 0,
    timeoutMs: 5_000,
    say: (line) => said.push(line),
    open: (address) => {
      asked = new URL(address);
      nonce = asked.searchParams.get('nonce') ?? '';
      const back = new URL(asked.searchParams.get('redirect_uri') ?? '');
      void fetch(`${back.origin}${back.pathname}?${answer(asked)}`).catch(() => {});
    },
  });
  return { result, said, asked, tokenFile };
}

it('the code is exchanged with the verifier matching the challenge, and the file is owner-only', async () => {
  const { result, asked, tokenFile } = await signedIn(
    (url) => `code=c1&state=${url.searchParams.get('state') ?? ''}&client_id=oaiapp_fake_client`,
  );
  expect(result).toEqual({ ok: true });
  expect(issuer.exchanges).toHaveLength(1);
  const exchange = issuer.exchanges[0];
  expect(exchange?.get('grant_type')).toBe('authorization_code');
  expect(exchange?.get('code')).toBe('c1');
  const verifier = exchange?.get('code_verifier') ?? '';
  expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
    asked?.searchParams.get('code_challenge'),
  );
  expect(exchange?.get('redirect_uri')).toBe(asked?.searchParams.get('redirect_uri'));
  const held = JSON.parse(readFileSync(tokenFile, 'utf8')) as Record<string, unknown>;
  expect(held).toMatchObject({
    clientId: 'oaiapp_fake_client',
    accessToken: ACCESS,
    refreshToken: REFRESH,
  });
  expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
});

it('an answer with another state is refused, and nothing is exchanged or written', async () => {
  const { result, tokenFile } = await signedIn(
    () => 'code=c1&state=not-the-one-asked-for&client_id=oaiapp_fake_client',
  );
  expect(result).toEqual({ ok: false, code: 'SIGN_IN_STATE_MISMATCH' });
  expect(issuer.exchanges).toHaveLength(0);
  expect(() => statSync(tokenFile)).toThrow();
});

it('an answer that declines the sign-in is refused by name', async () => {
  const { result } = await signedIn(
    (url) =>
      `error=access_denied&state=${url.searchParams.get('state') ?? ''}&client_id=oaiapp_fake_client`,
  );
  expect(result).toEqual({ ok: false, code: 'SIGN_IN_DECLINED' });
  expect(issuer.exchanges).toHaveLength(0);
});

it('nothing said during the sign-in holds a token, the code or the verifier', async () => {
  const { said } = await signedIn(
    (url) => `code=c1&state=${url.searchParams.get('state') ?? ''}&client_id=oaiapp_fake_client`,
  );
  const verifier = issuer.exchanges[0]?.get('code_verifier') ?? 'none';
  const text = said.join('\n');
  for (const secret of [ACCESS, REFRESH, verifier, 'code=c1']) expect(text).not.toContain(secret);
});
