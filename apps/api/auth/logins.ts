// SPDX-License-Identifier: AGPL-3.0-only
//
// The sign-in provider's calls for a login whose access has ended (C58): end
// every session the login has, and deactivate the login so it cannot sign in
// again. And C59's admin removal of one factor, an owner's reset of a lost
// authenticator: `DELETE /admin/users/<id>/factors/<factor id>`.
//
// Both are GoTrue's `PUT /admin/users/<id>` with a ban of 100 years, under the
// admin API's key (`SUPABASE_SERVICE_KEY`, sent as the bearer and as
// `apikey`). Done is the user named back with a ban ending at least a year from
// now, or GoTrue's 404 naming the user gone (`user_not_found`): a user deleted
// can never sign in again, so the ban's purpose holds and the step is final,
// never owed again. Any other 404 is doubt, and the step stays owed.
// GoTrue has no admin call that ends a user's sessions: its sign-out
// needs a bearer naming the user. A banned user's every refresh and sign-in is
// refused, so the ban is the session end (ORCH46); what access token is left
// runs out within the hour, and the API refuses it from the ending's commit.
// GoTrue keeps a banned user's sessions and refresh tokens, so an unban would
// revive them: restoring access is a new login, never an unban (ORCH46).
//
// Every answer is distrusted as C59's are (TR-SEC4R-5): one
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
  /** The admin API's key, asked for each call (a local one is minted per call). */
  readonly adminKey: () => Promise<string>;
  /** Milliseconds before a call is abandoned as slow. */
  readonly timeoutMs?: number;
  /** Bytes of answer read before it is abandoned as oversized. */
  readonly maxBytes?: number;
  /** Injected for tests; the platform's `fetch` otherwise. */
  readonly fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 16 * 1024;
// Admin user responses include the person's metadata. Only the user update
// reads up to one megabyte; factor deletion keeps the smaller bound.
const USER_MAX_BYTES = 1024 * 1024;
/** GoTrue takes a Go duration; this is 100 years. */
const BAN_DURATION = '876000h';
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

type Sent =
  | { readonly status: number; readonly text: string }
  | { readonly fault: ProviderFault; readonly gone?: 'user' | 'factor' };

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
  // The ban is both steps: each is done once the ban holds, and asking twice is safe.
  const ban = async (subject: string): Promise<ProviderAnswer<void>> => {
    if (!isUserId(subject)) return { ok: false, fault: 'refused' };
    const sent = await call(
      { ...to, maxBytes: options.maxBytes ?? USER_MAX_BYTES },
      'PUT',
      `/admin/users/${subject}`,
      await options.adminKey(),
      { ban_duration: BAN_DURATION },
    );
    // A 404 naming the user gone: nothing is left to ban, the step is done.
    if ('fault' in sent) {
      return sent.gone === 'user'
        ? { ok: true, value: undefined }
        : { ok: false, fault: sent.fault };
    }
    return bannedAnswer(sent.text, subject);
  };
  // C59 (ORCH65-Q3): an owner's reset of a lost factor. Done is the factor named back.
  const deleteFactor = async (subject: string, factorId: string): Promise<ProviderAnswer<void>> => {
    if (!isUserId(subject) || !isUserId(factorId)) return { ok: false, fault: 'refused' };
    const path = `/admin/users/${subject}/factors/${factorId}`;
    const sent = await call(to, 'DELETE', path, await options.adminKey());
    // A 404 naming the factor gone is a removal already done (an answer lost before).
    if ('fault' in sent) {
      return sent.gone === 'factor'
        ? { ok: true, value: undefined }
        : { ok: false, fault: sent.fault };
    }
    return namedBack(sent.text, factorId);
  };
  return { endSessions: ban, deactivate: ban, deleteFactor };
}

async function call(
  to: Destination,
  method: 'PUT' | 'DELETE',
  path: string,
  key: string,
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
        authorization: `Bearer ${key}`,
        apikey: key,
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
  if (response.status === 404) {
    const gone = notFound(read.text);
    if (gone !== undefined) return { fault: 'refused', gone };
  }
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

/** The factor named back by its id, as GoTrue answers a removal. */
function namedBack(text: string, factorId: string): ProviderAnswer<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, fault: 'malformed' };
  }
  const named =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)['id']
      : undefined;
  return named === factorId ? { ok: true, value: undefined } : { ok: false, fault: 'malformed' };
}

/** GoTrue's error codes for a 404 that names what is gone, and nothing looser. */
const GONE: Readonly<Record<string, 'user' | 'factor'>> = {
  user_not_found: 'user',
  mfa_factor_not_found: 'factor',
};

/** What a 404's body names gone: the user or the factor, by its exact code; else nothing. */
function notFound(text: string): 'user' | 'factor' | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const code = (parsed as Readonly<Record<string, unknown>>)['error_code'];
    return typeof code === 'string' && Object.hasOwn(GONE, code) ? GONE[code] : undefined;
  } catch {
    return undefined;
  }
}

/** GoTrue's user and factor ids: a UUID, and nothing else is sent as one. */
function isUserId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
}
