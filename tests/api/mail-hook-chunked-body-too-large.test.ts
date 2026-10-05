// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b hook signature: a body past the hook's limit is refused 413 before
// anything reads it, also when it arrives in chunks with no content-length,
// where the size is only known by counting the bytes as they come.

import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { EMAIL_HOOK_MAX_BYTES } from '../../packages/core-connectors/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { MAIL_HOOK_PATH, mountMailHook } from '../../apps/api/mail-hook.ts';

it('AW-07b hook signature: a chunked body over the limit with no content-length is refused 413 HOOK_TOO_LARGE', async () => {
  const app = new Hono();
  // Nothing past the size check may reach the database.
  mountMailHook(app, {} as Database, {
    secret: 'whsec_unused',
    businesses: async () => await Promise.reject(new Error('the body was read')),
  });
  const chunk = new Uint8Array(1024).fill(0x7b);
  const chunks = 70;
  expect(chunks * chunk.byteLength).toBeGreaterThan(EMAIL_HOOK_MAX_BYTES);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === chunks) return controller.close();
      sent += 1;
      controller.enqueue(chunk);
    },
  });
  const request = new Request(`http://api.test${MAIL_HOOK_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    duplex: 'half',
  } as RequestInit);
  expect(request.headers.has('content-length')).toBe(false);
  const response = await app.fetch(request);
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ code: 'HOOK_TOO_LARGE' });
});
