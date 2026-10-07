// SPDX-License-Identifier: AGPL-3.0-only
//
// The live routes' one way to open a stream (C4, T2f, INB-1f), and what a
// stream is (moved here from `live-follow.ts` for its line cap).

import type { Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { holdQuotaSlot } from '../../packages/core-records/src/index.ts';

/** What a stream writes through and ends: the SSE stream, or one topic group's share of it. */
export type LiveStream = Pick<SSEStreamingApi, 'writeSSE' | 'abort' | 'aborted' | 'onAbort'>;

/**
 * Ends `stream` with its request. A tab that leaves while the route still
 * awaits its door closes the socket before the stream exists, and the stream
 * never hears of it; the request's signal does (FIX-2B1 RS B1).
 */
export function endsWithRequest(stream: Pick<LiveStream, 'abort'>, request: AbortSignal): void {
  if (request.aborted) stream.abort();
  else
    request.addEventListener(
      'abort',
      () => {
        stream.abort();
      },
      { once: true },
    );
}

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
