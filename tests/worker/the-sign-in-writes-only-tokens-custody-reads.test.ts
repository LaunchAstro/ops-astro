// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's plan sign-in writes only tokens custody will read back (#1620):
// an issued client id or a token custody would refuse is refused at sign-in,
// SIGN_IN_TOKENS_UNUSABLE, and nothing is written, instead of a "signed in"
// that leaves custody asking for a sign-in forever. A token file that is there
// but unreadable is never signed over: its saved client and account would be
// skipped. Control: a well-formed sign-in writes.

import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { signIn } from '../../apps/model-agent/chatgpt-sign-in.ts';
import { fake, identity, type Fake } from './plan-fakes.ts';

let folder: string;
let tokenFile: string;
let issuer: Fake;

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'plan-writes-'));
  tokenFile = join(folder, 'tokens.json');
  issuer = await fake();
});

afterEach(async () => {
  await issuer.close();
  rmSync(folder, { recursive: true, force: true });
});

/** A sign-in issued `clientId`, answered with `tokens`; whether the browser was opened. */
async function signedIn(clientId: string, tokens: { access: string; refresh: string }) {
  const signer = identity(issuer.origin);
  let nonce = '';
  let opened = false;
  issuer.answer = (heard) =>
    signer.serve(heard) ?? {
      status: 200,
      type: 'application/json',
      body: JSON.stringify({
        access_token: tokens.access,
        refresh_token: tokens.refresh,
        expires_in: 3600,
        scope: 'openid offline_access resource.invoke chatgpt.tokens.use.direct',
        id_token: signer.idToken({
          iss: issuer.origin,
          aud: clientId,
          sub: 'owner-account',
          nonce,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      }),
    };
  const result = await signIn({
    issuer: issuer.origin,
    tokenFile,
    port: 0,
    timeoutMs: 5_000,
    say: () => {},
    open: (address) => {
      opened = true;
      const asked = new URL(address);
      nonce = asked.searchParams.get('nonce') ?? '';
      const callback = new URL(asked.searchParams.get('redirect_uri') ?? '');
      callback.searchParams.set('code', 'fake_code');
      callback.searchParams.set('state', asked.searchParams.get('state') ?? '');
      callback.searchParams.set('client_id', clientId);
      void fetch(callback).catch(() => {});
    },
  });
  return { result, opened };
}

const fine = { access: 'access-fine-secret', refresh: 'refresh-fine-secret' };

it.each([
  ['a client id custody would refuse', 'oa1', fine],
  ['an access token with a space', 'oaiapp_fake', { ...fine, access: 'access with space' }],
  ['a refresh token too short', 'oaiapp_fake', { ...fine, refresh: 'short' }],
])('a sign-in issued %s writes nothing', async (_what, clientId, tokens) => {
  const { result } = await signedIn(clientId, tokens);
  expect(result).toEqual({ ok: false, code: 'SIGN_IN_TOKENS_UNUSABLE' });
  expect(existsSync(tokenFile)).toBe(false);
});

it('a token file that is there but unreadable is not signed over, and no browser opens', async () => {
  writeFileSync(tokenFile, '{"clientId":"oaiapp_fake"}', { mode: 0o600 });
  chmodSync(tokenFile, 0o644);
  const { result, opened } = await signedIn('oaiapp_other', fine);
  expect(result).toEqual({ ok: false, code: 'SIGN_IN_TOKEN_FILE_UNREADABLE' });
  expect(opened).toBe(false);
  expect(issuer.heard).toHaveLength(0);
});

it('control: a well-formed sign-in writes', async () => {
  expect((await signedIn('oaiapp_fake', fine)).result).toEqual({ ok: true });
  expect(existsSync(tokenFile)).toBe(true);
});
