// SPDX-License-Identifier: AGPL-3.0-only
//
// The live routes' one way to open a stream (C4, T2f, INB-1f).

import type { Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { holdQuotaSlot } from '../../packages/core-records/src/index.ts';
import { endsWithRequest } from './live-follow.ts';

/** A stream ended with its request, holding its caller's concurrent slot until it ends (API-3). */
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
