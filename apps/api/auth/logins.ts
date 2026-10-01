// SPDX-License-Identifier: AGPL-3.0-only
//
// The sign-in provider's calls for a login whose access has ended (C58): end
// every session the login has, which revokes their refresh tokens, and
// deactivate the login so it cannot sign in again.
//
// - **Sessions**: GoTrue's `POST /logout?scope=global`, with a short-lived
//   bearer naming the login's own subject and no session, which GoTrue answers
//   by ending every session of that user. Done is a `204` with no body.
// - **Login**: GoTrue's `PUT /admin/users/<id>` with a ban of 100 years, under
//   a short-lived administrative bearer. Done is the user named back with a
//   ban ending at least a year from now.
//
// Both bearers are minted by the composition root from the secret the API
// already verifies every session with, so this adds no credential the server
// did not hold. Every answer is distrusted as C59's are (TR-SEC4R-5): one
// fixed destination, no redirect followed, a time limit the provider cannot
// stretch, a size limit read off the stream, a shape per call. Anything else
// is a fault by its kind, never a partial success, and never the provider's
// own words.

import type {
  LoginProvider,
  ProviderAnswer,
  ProviderFault,
} from '../../../packages/core-commands/src/index.ts';
import { isTimeout, readBounded } from './factors.ts';

export interface GoTrueLoginOptions {
  /** GoTrue's own URL, `GOTRUE_URL`. The only destination this adapter calls. */
  readonly baseUrl: string;
  /** A short-lived administrative bearer for the deactivation. */
  readonly adminToken: () => Promise<string>;
  /** A short-lived bearer naming the subject, for its global sign-out. */
  readonly subjectToken: (subject: string) => Promise<string>;
  /** Milliseconds before a call is abandoned as slow. */
  readonly timeoutMs?: number;
  /** Bytes of answer read before it is abandoned as oversized. */
  readonly maxBytes?: number;
  /** Injected for tests; the platform's `fetch` otherwise. */
  readonly fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 16 * 1024;
/** GoTrue takes a Go duration; this is 100 years. */
const BAN_DURATION = '876000h';
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

type Sent = { readonly status: number; readonly text: string } | { readonly fault: ProviderFault };

interface Destination {
  readonly base: URL;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly send: typeof fetch;
}

export function createGoTrueLogins(options: GoTrueLoginOptions): LoginProvider {
  const to: Destination = {
    base: new URL(options.baseUrl),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    send: options.fetch ?? fetch,
  };
  return {
    async endSessions(subject) {
      if (!isUserId(subject)) return { ok: false, fault: 'refused' };
      const bearer = await options.subjectToken(subject);
      const sent = await call(to, 'POST', '/logout?scope=global', bearer);
      if ('fault' in sent) return { ok: false, fault: sent.fault };
      return sent.status === 204 && sent.text === ''
        ? { ok: true, value: undefined }
        : { ok: false, fault: 'malformed' };
    },

    async deactivate(subject) {
      if (!isUserId(subject)) return { ok: false, fault: 'refused' };
      const bearer = await options.adminToken();
      const sent = await call(to, 'PUT', `/admin/users/${subject}`, bearer, {
        ban_duration: BAN_DURATION,
      });
      if ('fault' in sent) return { ok: false, fault: sent.fault };
      return bannedAnswer(sent.text, subject);
    },
  };
}

async function call(
  to: Destination,
  method: 'POST' | 'PUT',
  path: string,
  bearer: string,
  body?: Readonly<Record<string, unknown>>,
): Promise<Sent> {
  // The path is built here from fixed segments and a subject already shaped;
  // the origin is the configured one, and the base's own path (`/auth/v1` on
  // a hosted project) is kept.
  const url = new URL(`${to.base.pathname.replace(/\/+$/u, '')}${path}`, to.base);
  if (url.origin !== to.base.origin) return { fault: 'refused' };
  let response: Response;
  try {
    const sent = to.send(url, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(to.timeoutMs),
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Raced as well as signalled: an answer that ignores the signal still runs
    // out of time here.
    const late = await Promise.race([
      sent,
      new Promise<'slow'>((resolve) => {
        setTimeout(() => resolve('slow'), to.timeoutMs).unref();
      }),
    ]);
    if (late === 'slow') return { fault: 'slow' };
    response = late;
  } catch (cause) {
    return { fault: isTimeout(cause) ? 'slow' : 'unreachable' };
  }
  const read = await readBounded(response, to.maxBytes, to.timeoutMs);
  if ('fault' in read) return { fault: read.fault };
  if (response.status >= 400 && response.status < 500) return { fault: 'refused' };
  if (!response.ok) return { fault: 'unreachable' };
  return { status: response.status, text: read.text };
}

/** The user named back, banned for at least a year from now. */
function bannedAnswer(text: string, subject: string): ProviderAnswer<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, fault: 'malformed' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, fault: 'malformed' };
  }
  const { id, banned_until: until } = parsed as Readonly<Record<string, unknown>>;
  const ends = typeof until === 'string' && until.length <= 64 ? Date.parse(until) : Number.NaN;
  return id === subject && Number.isFinite(ends) && ends > Date.now() + YEAR_MS
    ? { ok: true, value: undefined }
    : { ok: false, fault: 'malformed' };
}

/** GoTrue's user id: a UUID, and nothing else is sent as one. */
function isUserId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
}
