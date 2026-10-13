// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's plan sign-in when its token file cannot be written (#1620): the
// rename fails, no copy of the tokens is left beside the file, and the
// sign-in is refused SIGN_IN_STORE_FAILED rather than throwing. The control,
// a sign-in that writes, also leaves no copy (the identity test's control
// covers what it stores).
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { signIn } from '../../apps/model-agent/chatgpt-sign-in.ts';
import { fake, identity } from './plan-fakes.ts';

// oxlint-disable-next-line max-lines-per-function -- one fake issuer and one sign-in, end to end
it('a failed sign-in rename leaves no extra credential file and returns its refusal', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'sol-1634-store-'));
  const tokenFile = join(folder, 'tokens.json');
  const issuer = await fake();
  const signer = identity(issuer.origin);
  let nonce = '';
  issuer.answer = (heard) => {
    const published = signer.serve(heard);
    if (published !== undefined) return published;
    // A directory at the target reproduces a failed atomic rename after
    // the temporary credential file was successfully written.
    mkdirSync(tokenFile);
    return {
      status: 200,
      type: 'application/json',
      body: JSON.stringify({
        access_token: 'synthetic-access-secret',
        refresh_token: 'synthetic-refresh-secret',
        expires_in: 3600,
        scope: 'openid offline_access resource.invoke chatgpt.tokens.use.direct',
        id_token: signer.idToken({
          iss: issuer.origin,
          aud: 'oaiapp_sol_fake',
          sub: 'owner',
          nonce,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      }),
    };
  };
  try {
    let result: unknown;
    try {
      result = await signIn({
        issuer: issuer.origin,
        tokenFile,
        port: 0,
        timeoutMs: 5000,
        say: () => {},
        open: (address) => {
          const asked = new URL(address);
          nonce = asked.searchParams.get('nonce') ?? '';
          const callback = new URL(asked.searchParams.get('redirect_uri') ?? '');
          callback.searchParams.set('code', 'synthetic-code');
          callback.searchParams.set('state', asked.searchParams.get('state') ?? '');
          callback.searchParams.set('client_id', 'oaiapp_sol_fake');
          void fetch(callback).catch(() => {});
        },
      });
    } catch (error) {
      result = error instanceof Error ? error.name : 'thrown';
    }
    expect
      .soft(
        readdirSync(folder).filter((name) => name.endsWith('.next')),
        'failed write must remove the temporary token copy',
      )
      .toEqual([]);
    expect.soft(result).toEqual({ ok: false, code: 'SIGN_IN_STORE_FAILED' });
  } finally {
    await issuer.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
