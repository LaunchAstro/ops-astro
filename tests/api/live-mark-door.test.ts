// SPDX-License-Identifier: AGPL-3.0-only
//
// C2's mark route runs the door before it reads a byte of the body: an
// unauthenticated or cross-site mark is refused without the body being read,
// so a body past the limit still gets the door's answer (review 2b1, minor 4).

import { describe, expect, it } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { PREFIX, SESSION_COOKIE } from '../../packages/core-wire/src/index.ts';

const options = {
  verify: () => Promise.resolve('absent'),
  resolveBusiness: () => Promise.resolve(),
  live: { presence: { mark: () => true, seenBy: () => [] } },
} as unknown as Parameters<typeof createApi>[0];

/** A body that says whether anything pulled on it, and is over any limit. */
function watchedBody(): { body: ReadableStream<Uint8Array>; pulled: () => boolean } {
  let pulled = false;
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled = true;
        sent += 1;
        if (sent > 64) controller.close();
        else controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  return { body, pulled: () => pulled };
}

async function markWith(headers: Record<string, string>) {
  const { body, pulled } = watchedBody();
  const response = await createApi(options).request(`${PREFIX.person}acme/live/mark`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    duplex: 'half',
  } as RequestInit);
  const answer = (await response.json()) as { code?: string };
  return { status: response.status, code: answer.code, pulled: pulled() };
}

describe('C2 live/mark: the door before the body', () => {
  it('an unauthenticated mark is refused without its body being read', async () => {
    const seen = await markWith({});
    expect(seen.code).toBe('AUTH_UNKNOWN_LOGIN');
    expect(seen.pulled).toBe(false);
  });

  it('a cross-site mark on a session cookie is refused without its body being read', async () => {
    const seen = await markWith({
      cookie: `${SESSION_COOKIE}-${'a'.repeat(32)}=abc`,
      'sec-fetch-site': 'cross-site',
    });
    expect(seen.code).toBe('AUTH_CROSS_SITE');
    expect(seen.pulled).toBe(false);
  });
});
