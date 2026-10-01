// SPDX-License-Identifier: AGPL-3.0-only
//
// Langfuse's health, read for the operations view (C34). Langfuse is the
// optional tracing service; where it is switched on, its public health route
// says whether it is up.
//
// Its answer is distrusted until it is shaped, as the sign-in provider's is
// (`auth/factors.ts`): one fixed destination, no redirect followed, a time
// limit the answer cannot stretch, a size limit read off the stream, and one
// shape. A shaped answer is the service's state: `OK` is up, a server error
// naming a status is down. Anything else is a read failure by kind, which
// says nothing about the service; the answer's own words go nowhere. No
// credential is sent: the route needs none.

import type { HealthSource, SourceAnswer } from '../../../packages/core-commands/src/index.ts';
import { isTimeout, readBounded } from '../auth/factors.ts';

export interface LangfuseHealthOptions {
  /** Langfuse's own URL. The only destination this adapter calls. */
  readonly baseUrl: string;
  /** Milliseconds before a read is abandoned as slow. */
  readonly timeoutMs?: number;
  /** Bytes of answer read before it is abandoned as oversized. */
  readonly maxBytes?: number;
  /** Injected for tests; the platform's `fetch` otherwise. */
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_BYTES = 4096;
const STATUS_LIMIT = 200;

export function createLangfuseHealth(options: LangfuseHealthOptions): HealthSource {
  const base = new URL(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const send = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  // Served under a path is kept: the route is appended to the base's path.
  const url = new URL(`${base.pathname.replace(/\/+$/u, '')}/api/public/health`, base);

  return {
    async observe(): Promise<SourceAnswer> {
      let response: Response;
      try {
        response = await send(url, {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { accept: 'application/json' },
        });
      } catch (cause) {
        return { ok: false, fault: isTimeout(cause) ? 'slow' : 'unreachable' };
      }
      const read = await readBounded(response, maxBytes, timeoutMs);
      if ('fault' in read) return { ok: false, fault: read.fault };
      if (response.status >= 400 && response.status < 500) return { ok: false, fault: 'refused' };
      const status = statusOf(read.text);
      if (status === undefined) return { ok: false, fault: 'malformed' };
      const up = response.ok && status === 'OK';
      // A 2xx that is not `OK`, or a status on a 3xx, is no shape Langfuse gives.
      if (!up && response.status < 500) return { ok: false, fault: 'malformed' };
      return {
        ok: true,
        services: [{ name: 'tracing', scope: 'installation', up, observedAt: now() }],
      };
    },
  };
}

/** `{ "status": "<a word>" }`: the one field read; the rest is ignored. */
function statusOf(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const status = (parsed as Readonly<Record<string, unknown>>)['status'];
  return typeof status === 'string' && status.length > 0 && status.length <= STATUS_LIMIT
    ? status
    : undefined;
}
