// SPDX-License-Identifier: AGPL-3.0-only
//
// #1620 P2: the owner's plan sign-in, end to end against a loopback stand-in
// for OpenAI's sign-in origin with a real RSA key set. Nothing is stored
// unless the grant includes plan use and its ID token validates (issuer,
// audience, nonce, expiry, signature); another account is refused; and no
// line said to the owner, nor any answer, carries token text.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { signIn } from '../../apps/model-agent/chatgpt-sign-in.ts';
import { tokenHolder } from '../../packages/core-custody/src/plan-token.ts';
import {
  HOUR,
  T0,
  fileBytes,
  seed,
  tempDir,
  tokens,
} from '../custody/fixtures/plan-token-world.ts';
import {
  HOST_ID,
  ISSUED,
  browser,
  filesHolding,
  hostRecord,
  idToken,
  seedHost,
  startSignInIssuer,
  type IdClaims,
  type SignInIssuer,
} from '../custody/fixtures/sign-in-world.ts';

let opened: SignInIssuer | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await opened?.close();
  opened = undefined;
  cleanup?.();
  cleanup = undefined;
});
async function world() {
  const made = tempDir();
  cleanup = made.done;
  opened = await startSignInIssuer();
  return { ...made, issuer: opened };
}
const SECRETS = ['synthetic-access-one', 'synthetic-refresh-one', 'synthetic-code'];
function saysNothingSecret(lines: readonly string[], answer: unknown): void {
  const said = `${lines.join('\n')}\n${JSON.stringify(answer)}`;
  for (const secret of SECRETS) expect(said).not.toContain(secret);
}
const run = (file: string, issuer: SignInIssuer, b = browser(issuer)) =>
  signIn({ issuer: issuer.origin, tokenFile: file, port: 0, timeoutMs: 10_000, say: b.say });

// oxlint-disable-next-line max-lines-per-function -- one sign-in flow, end to end
describe('the owner signs in', () => {
  it('a first sign-in registers, exchanges by the published flow, and stores a pair a holder presents', async () => {
    const { file, dir, issuer } = await world();
    const b = browser(issuer);
    const answer = await run(file, issuer, b);
    expect(answer).toEqual({ ok: true });
    const asked = b.asked[0];
    expect(asked?.pathname).toBe('/api/accounts/authorize');
    const p = asked?.searchParams;
    expect(p?.get('client_id')).toBe('dynamic_agent_client');
    expect(p?.get('agent_name_hint')).toBe('Ops Astro');
    expect(p?.get('scope')).toBe(
      'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    );
    expect(p?.get('resource')).toBe('https://api.openai.com/v1');
    expect(p?.get('response_type')).toBe('code');
    expect(p?.get('code_challenge_method')).toBe('S256');
    expect(p?.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/u);
    const host = hostRecord(file) as { extAgentHostId: string; clientId: string };
    expect(p?.get('ext_agent_host_id')).toBe(host.extAgentHostId);
    expect(host.clientId).toBe(ISSUED);
    const form = issuer.forms[0];
    expect(Object.fromEntries(form ?? [])).toMatchObject({
      grant_type: 'authorization_code',
      client_id: ISSUED,
      code: 'synthetic-code',
      redirect_uri: p?.get('redirect_uri'),
      resource: 'https://api.openai.com/v1',
    });
    const challenge = createHash('sha256')
      .update(form?.get('code_verifier') ?? '')
      .digest('base64url');
    expect(challenge).toBe(p?.get('code_challenge'));
    saysNothingSecret(b.lines, answer);
    const holder = tokenHolder({
      file,
      tokenUrl: new URL(`${issuer.origin}/api/accounts/oauth/token`),
    });
    expect(await holder.prepare()).toEqual({ ok: true });
    expect(holder.present()).toEqual({ ok: true, accessToken: 'synthetic-access-one' });
    expect(filesHolding(dir, 'synthetic-refresh-one')).toEqual(['plan-token.json']);
  });

  it('a later sign-in reuses the registered client id and host id, with no name hint', async () => {
    const { file, issuer } = await world();
    await seedHost(file, { extAgentHostId: HOST_ID, clientId: ISSUED });
    const b = browser(issuer, (asked) => ({
      code: 'synthetic-code',
      state: asked.searchParams.get('state') ?? '',
    }));
    expect(await run(file, issuer, b)).toEqual({ ok: true });
    expect(b.asked[0]?.searchParams.get('client_id')).toBe(ISSUED);
    expect(b.asked[0]?.searchParams.has('agent_name_hint')).toBe(false);
    expect(b.asked[0]?.searchParams.get('ext_agent_host_id')).toBe(HOST_ID);
    expect(hostRecord(file)).toEqual({ extAgentHostId: HOST_ID, clientId: ISSUED });
  });
});

// oxlint-disable-next-line max-lines-per-function -- every way an ID token can fail, one table
describe('nothing is stored unless the ID token validates', () => {
  const cases: [string, (i: SignInIssuer, form: URLSearchParams) => unknown][] = [
    [
      'another issuer',
      (i, f) => idToken({ ...i.claims(f), iss: 'https://auth.example.com' }, i.key),
    ],
    [
      'another audience',
      (i, f) => idToken({ ...i.claims(f), aud: 'oaiapp_synthetic-other' }, i.key),
    ],
    ['another nonce', (i, f) => idToken({ ...i.claims(f), nonce: 'synthetic-other-nonce' }, i.key)],
    ['no nonce', (i, f) => idToken({ ...i.claims(f), nonce: undefined }, i.key)],
    [
      'an expired token',
      (i, f) => idToken({ ...i.claims(f), exp: Math.floor(Date.now() / 1000) - 1 }, i.key),
    ],
    ['no account', (i, f) => idToken({ ...i.claims(f), sub: '' }, i.key)],
    ['a key the issuer never published', (i, f) => idToken(i.claims(f), i.strangerKey)],
    [
      'an unknown key id',
      (i, f) => idToken(i.claims(f), i.key, { alg: 'RS256', kid: 'synthetic-other-kid' }),
    ],
    ['alg none', (i, f) => idToken(i.claims(f), i.key, { alg: 'none', kid: 'synthetic-kid' })],
    [
      'claims changed after signing',
      (i, f) => {
        const [head, , sig] = idToken(i.claims(f), i.key).split('.');
        const claims: IdClaims = { ...i.claims(f), sub: 'synthetic-subject-z' };
        return `${head}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
      },
    ],
    ['a null ID token', () => null],
    ['a token that is not a JWT', () => 'synthetic.not-a-jwt'],
  ];
  it.each(cases)(
    'refuses %s SIGN_IN_IDENTITY_INVALID, with no token file or copy',
    async (_, make) => {
      const { file, dir, issuer } = await world();
      issuer.answer((form, valid) => ({ body: { ...valid, id_token: make(issuer, form) } }));
      const b = browser(issuer);
      const answer = await run(file, issuer, b);
      expect(answer).toEqual({ ok: false, code: 'SIGN_IN_IDENTITY_INVALID' });
      expect(existsSync(file)).toBe(false);
      expect(filesHolding(dir, 'synthetic-')).toEqual([]);
      saysNothingSecret(b.lines, answer);
    },
  );

  it('refuses a sign-in for another account SIGN_IN_ACCOUNT_CHANGED, leaving the pair as it was', async () => {
    const { file, issuer } = await world();
    await seedHost(file, { extAgentHostId: HOST_ID, clientId: ISSUED });
    await seed(file, {
      state: 'ready',
      tokens: { ...tokens('kept', T0 + HOUR), clientId: ISSUED },
    });
    const before = fileBytes(file);
    issuer.answer((form, valid) => ({
      body: { ...valid, id_token: idToken(issuer.claims(form, 'synthetic-subject-b'), issuer.key) },
    }));
    const answer = await run(file, issuer);
    expect(answer).toEqual({ ok: false, code: 'SIGN_IN_ACCOUNT_CHANGED' });
    expect(fileBytes(file).equals(before)).toBe(true);
  });

  it('refuses a grant without plan use SIGN_IN_PLAN_USE_NOT_GRANTED', async () => {
    const { file, issuer } = await world();
    issuer.answer((_, valid) => ({
      body: { ...valid, scope: 'openid profile email offline_access' },
    }));
    expect(await run(file, issuer)).toEqual({ ok: false, code: 'SIGN_IN_PLAN_USE_NOT_GRANTED' });
    expect(existsSync(file)).toBe(false);
  });

  it('refuses tokens custody cannot read back SIGN_IN_TOKENS_UNUSABLE', async () => {
    const { file, issuer } = await world();
    issuer.answer((_, valid) => ({ body: { ...valid, refresh_token: 'synthetic-"quoted"' } }));
    expect(await run(file, issuer)).toEqual({ ok: false, code: 'SIGN_IN_TOKENS_UNUSABLE' });
    expect(existsSync(file)).toBe(false);
  });
});

// oxlint-disable-next-line max-lines-per-function -- every callback and exchange refusal, one table
describe('the callback and the exchange', () => {
  const callbacks: [string, (asked: URL) => Record<string, string | undefined>, string][] = [
    [
      'another state',
      () => ({ code: 'synthetic-code', state: 'synthetic-state', client_id: ISSUED }),
      'SIGN_IN_STATE_MISMATCH',
    ],
    [
      'a declined approval',
      (a) => ({ error: 'access_denied', state: a.searchParams.get('state') ?? '' }),
      'SIGN_IN_DECLINED',
    ],
    [
      'a registration with no issued client id',
      (a) => ({ code: 'synthetic-code', state: a.searchParams.get('state') ?? '' }),
      'SIGN_IN_REGISTRATION_INCOMPLETE',
    ],
    [
      'the registration entrypoint as issued id',
      (a) => ({
        code: 'synthetic-code',
        state: a.searchParams.get('state') ?? '',
        client_id: 'dynamic_agent_client',
      }),
      'SIGN_IN_REGISTRATION_INCOMPLETE',
    ],
  ];
  it.each(callbacks)('refuses %s before any exchange', async (_, callback, code) => {
    const { file, issuer } = await world();
    expect(await run(file, issuer, browser(issuer, callback))).toEqual({ ok: false, code });
    expect(issuer.forms).toHaveLength(0);
    expect(existsSync(file)).toBe(false);
  });

  it('refuses a later sign-in whose callback names another client id', async () => {
    const { file, issuer } = await world();
    await seedHost(file, { extAgentHostId: HOST_ID, clientId: ISSUED });
    const b = browser(issuer, (a) => ({
      code: 'synthetic-code',
      state: a.searchParams.get('state') ?? '',
      client_id: 'oaiapp_synthetic-other',
    }));
    expect(await run(file, issuer, b)).toEqual({ ok: false, code: 'SIGN_IN_REGISTRATION_CHANGED' });
    expect(issuer.forms).toHaveLength(0);
  });

  it('refuses a refused exchange SIGN_IN_EXCHANGE_FAILED, and a sign-in nobody finishes times out', async () => {
    const { file, issuer } = await world();
    issuer.answer(() => ({ status: 400, body: { error: 'invalid_grant' } }));
    expect(await run(file, issuer)).toEqual({ ok: false, code: 'SIGN_IN_EXCHANGE_FAILED' });
    const idle = await signIn({
      issuer: issuer.origin,
      tokenFile: file,
      port: 0,
      timeoutMs: 200,
      say: () => {},
    });
    expect(idle).toEqual({ ok: false, code: 'SIGN_IN_TIMED_OUT' });
    expect(existsSync(file)).toBe(false);
  });

  it('refuses an issuer that is not https, or loopback http, before anything is written', async () => {
    const { file, dir } = await world();
    for (const bad of [
      'http://auth.openai.com',
      'https://auth.openai.com/path',
      'http://localhost:1455',
      'ftp://127.0.0.1',
    ])
      // oxlint-disable-next-line no-await-in-loop -- each refusal is checked against an untouched directory
      expect(await signIn({ issuer: bad, tokenFile: file, port: 0, say: () => {} })).toEqual({
        ok: false,
        code: 'SIGN_IN_ISSUER_REFUSED',
      });
    expect(readdirSync(dir)).toEqual([]);
  });
});
