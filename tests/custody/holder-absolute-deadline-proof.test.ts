// SPDX-License-Identifier: AGPL-3.0-only

import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { expect, it } from 'vitest';
import { tokenHolder } from '../../packages/core-custody/src/plan-token.ts';
import { startIssuer } from './fixtures/plan-issuer.ts';
import { T0, seed, tempDir, tokens } from './fixtures/plan-token-world.ts';

it('a connection completing after the absolute prepare deadline sends no refresh', async () => {
  const w = tempDir();
  const issuer = await startIssuer();
  let at = T0;
  const elapsed = () => {
    at = T0 + 31_000;
  };
  try {
    await seed(w.file, { state: 'ready', tokens: tokens('deadline', T0 + 240_000) });
    issuer.set({
      kind: 'json',
      status: 200,
      body: {
        access_token: 'synthetic-access-new',
        refresh_token: 'synthetic-refresh-new',
        expires_in: 3600,
      },
    });
    const holder = tokenHolder({ file: w.file, tokenUrl: issuer.url, now: () => at });
    // The clock advances while the outgoing socket connects, after lapse()'s preflight
    // check, before the first deadline poll. No transport or product code is mocked.
    subscribe('net.client.socket', elapsed);
    const result = await holder.prepare();
    expect(at).toBe(T0 + 31_000);
    expect(issuer.count(), 'refresh must not leave custody after its absolute deadline').toBe(0);
    expect(result.ok).toBe(false);
  } finally {
    unsubscribe('net.client.socket', elapsed);
    await issuer.close();
    w.done();
  }
});
