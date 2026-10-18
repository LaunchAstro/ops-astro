// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { productionTokenHolder } from '../../packages/core-custody/src/plan-token-production.ts';
import { tokenHolder } from '../../packages/core-custody/src/plan-token.ts';
import { startIssuer } from './fixtures/plan-issuer.ts';
import { seed, tempDir, tokens, T0 } from './fixtures/plan-token-world.ts';

it('a production holder cannot be redirected through its caller URL', async () => {
  const issuer = await startIssuer();
  const w = tempDir();
  const received: string[] = [];
  issuer.onRequest((form) => {
    received.push(form.get('refresh_token') ?? '');
  });
  try {
    await seed(w.file, { state: 'ready', tokens: tokens('mutation', T0 + 240_000) });
    const url = new URL('https://auth.openai.com/oauth/token');
    const built = productionTokenHolder({ file: w.file, tokenUrl: url, now: () => T0 });
    if (!built.ok) throw new Error('valid production issuer refused');
    url.href = issuer.url.href;
    await built.holder.prepare();
    expect(received, 'production refresh token reached the test-only issuer').toEqual([]);
    expect(issuer.count()).toBe(0);
  } finally {
    await issuer.close();
    w.done();
  }
});

it('test holders accept both loopback schemes', () => {
  const w = tempDir();
  try {
    for (const scheme of ['http', 'https']) {
      expect(() =>
        tokenHolder({ file: w.file, tokenUrl: new URL(`${scheme}://127.0.0.1:12345/token`) }),
      ).not.toThrow();
    }
  } finally {
    w.done();
  }
});
