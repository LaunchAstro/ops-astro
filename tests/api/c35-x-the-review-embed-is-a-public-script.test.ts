// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X, LF-2: the review embed is a script the product serves, read with no
// sign-in, so an agency-built site can load it beside its own code.

import { describe, expect, it } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import {
  LIVE_PROTOCOL,
  REVIEW_EMBED_PATH,
  reviewEmbedSnippet,
} from '../../packages/core-wire/src/index.ts';
import { testSignIn } from '../support/sign-in.ts';
import { ISSUER, database } from './session-cookie.fixture.ts';

const api = createApi({
  database,
  verify: createSupabaseVerifier(testSignIn(ISSUER)),
  resolveBusiness: (key) => Promise.resolve(key === 'alpha' ? 'business-alpha' : undefined),
  executeRead: (() => Promise.reject(new Error('no read'))) as never,
  executeCommand: (() => Promise.reject(new Error('no command'))) as never,
});

describe('C35-X the review embed', () => {
  it('is served with no sign-in as a script that is never sniffed', async () => {
    const answer = await api.request(REVIEW_EMBED_PATH);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(answer.headers.get('x-content-type-options')).toBe('nosniff');
    expect(answer.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(answer.headers.get('set-cookie')).toBeNull();
    const script = await answer.text();
    expect(script).toContain(LIVE_PROTOCOL.ping);
    expect(script).toContain(LIVE_PROTOCOL.hello);
  });

  it('answers only a read of the script itself', async () => {
    expect((await api.request(REVIEW_EMBED_PATH, { method: 'POST' })).status).toBe(404);
    expect((await api.request(`${REVIEW_EMBED_PATH}/x`)).status).toBe(404);
  });

  it('the onboarding snippet loads the served script and allows only the product to frame the site', () => {
    const snippet = reviewEmbedSnippet('https://ops.example.com');
    expect(snippet.script).toBe(
      `<script src="https://ops.example.com${REVIEW_EMBED_PATH}" async></script>`,
    );
    expect(snippet.header).toBe(
      "Content-Security-Policy: frame-ancestors 'self' https://ops.example.com",
    );
  });

  it('the onboarding snippet refuses anything but a bare https origin', () => {
    for (const origin of [
      'http://ops.example.com',
      'https://ops.example.com/',
      'https://ops.example.com/path',
      `https://user${'@'}ops.example.com`,
      'https://ops.example.com"><script>',
      'javascript:alert(1)',
      '',
    ]) {
      expect(() => reviewEmbedSnippet(origin), origin).toThrow(/origin/u);
    }
  });
});
