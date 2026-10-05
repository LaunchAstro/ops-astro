// SPDX-License-Identifier: AGPL-3.0-only
//
// The live routes' one way to open a stream (C4, T2f, INB-1f): ended with its
// request, and charged as one call at once for as long as it runs (API-3).

import type { Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { holdQuotaSlot } from '../../packages/core-records/src/index.ts';
import { endsWithRequest } from './live-follow.ts';

/**
 * A live stream for this request, ended with it. It answers at once and runs
 * on, and it is one call at once until it ends: it holds its caller's
 * concurrent slot past that answer and gives it back when it ends, however
 * it ends (API-3, `quota.ts`).
 */
export function liveStream(
  context: Context,
  run: (stream: SSEStreamingApi) => Promise<void>,
): Response {
  const release = holdQuotaSlot();
  return streamSSE(context, async (stream) => {
    try {
      endsWithRequest(stream, context.req.raw.signal);
      await run(stream);
    } finally {
      release();
    }
  });
}
