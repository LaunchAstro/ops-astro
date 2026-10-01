// SPDX-License-Identifier: AGPL-3.0-only
//
// The replay provider's modes, and the faults a provider really has: down (503), rate
// limited (429), and a connection cut after the request arrived. Moved whole from
// replay.ts to keep that file under the line limit; replay.ts re-exports `ReplayMode`.

import type { ServerResponse } from 'node:http';

export type ReplayMode =
  | 'answer'
  | 'oversized'
  | 'redirect'
  | 'malformed'
  | 'slow'
  | 'planted'
  | 'echo_credential'
  | 'nothing_happened'
  | 'costly'
  | 'unnamed_model'
  | 'bad_model'
  // AW-10: the provider down, rate limiting, or the connection cut. None began the work.
  | 'unavailable'
  | 'rate_limited'
  | 'cut';

/** The modes in which the stand-in never began the work. */
export const NOT_BEGUN: ReadonlySet<ReplayMode> = new Set([
  'nothing_happened',
  'unavailable',
  'rate_limited',
  'cut',
]);

/** AW-10's faults: down, rate limited, or the connection cut with no answer. */
export function faulted(mode: ReplayMode, response: ServerResponse): void {
  if (mode === 'cut') {
    response.socket?.destroy();
    return;
  }
  const status = mode === 'rate_limited' ? 429 : 503;
  response.writeHead(status, { 'content-type': 'application/json', 'retry-after': '5' });
  response.end(JSON.stringify({ code: mode }));
}
