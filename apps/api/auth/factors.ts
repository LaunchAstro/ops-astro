// SPDX-License-Identifier: AGPL-3.0-only
//
// The sign-in provider's second-factor calls (C59): enrol an authenticator
// app, prove a code, remove a factor. GoTrue's MFA endpoints, called with the
// person's own access token, so the provider applies its own rules to the
// person and this server holds no provider admin key for them.
//
// Every answer is distrusted until it is shaped (TR-SEC4R-5): one fixed
// destination, no redirect followed, a time limit, a size limit read off the
// stream rather than off a header, and a schema per call. Anything else is a
// `ProviderFault`, never a partial success, and the fault names only its kind:
// the provider's own words, which could carry anything, go nowhere.

import type {
  FactorProvider,
  ProviderAnswer,
  ProviderFault,
} from '../../../packages/core-commands/src/index.ts';

export interface GoTrueFactorOptions {
  /** GoTrue's own URL, `GOTRUE_URL`. The only destination this adapter calls. */
  readonly baseUrl: string;
  /** Milliseconds before a call is abandoned as slow. */
  readonly timeoutMs?: number;
  /** Bytes of answer read before it is abandoned as oversized. */
  readonly maxBytes?: number;
  /** Injected for tests; the platform's `fetch` otherwise. */
  readonly fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 16 * 1024;

type Json = Readonly<Record<string, unknown>>;

export function createGoTrueFactors(options: GoTrueFactorOptions): FactorProvider {
  const base = new URL(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const send = options.fetch ?? fetch;

  async function request(
    method: 'POST' | 'DELETE',
    path: string,
    accessToken: string,
    body?: Json,
  ): Promise<Response | { readonly fault: ProviderFault }> {
    // The path is built here from fixed segments and provider ids already
    // shaped by the caller; the origin is the configured one, never the answer's.
    // GoTrue may be served under a path (`/auth/v1` on a hosted project), so
    // the call's path is appended to the base's, never put in its place.
    const url = new URL(`${base.pathname.replace(/\/+$/u, '')}${path}`, base);
    if (url.origin !== base.origin) return { fault: 'refused' };
    try {
      return await send(url, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      return { fault: isTimeout(cause) ? 'slow' : 'unreachable' };
    }
  }

  async function call(
    method: 'POST' | 'DELETE',
    path: string,
    accessToken: string,
    body?: Json,
  ): Promise<ProviderAnswer<Json>> {
    const response = await request(method, path, accessToken, body);
    if (!(response instanceof Response)) return { ok: false, fault: response.fault };
    const read = await readBounded(response, maxBytes, timeoutMs);
    if ('fault' in read) return { ok: false, fault: read.fault };
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      return { ok: false, fault: 'malformed' };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, fault: 'malformed' };
    }
    // A 4xx is the provider saying no (a wrong code, an expired challenge);
    // it is not a fault in the answer, and it is not a success either.
    if (response.status >= 400 && response.status < 500) return { ok: false, fault: 'refused' };
    if (!response.ok) return { ok: false, fault: 'unreachable' };
    return { ok: true, value: parsed as Json };
  }

  return {
    async enrol(accessToken) {
      const answer = await call('POST', '/factors', accessToken, { factor_type: 'totp' });
      if (!answer.ok) return answer;
      const id = answer.value['id'];
      const totp = answer.value['totp'];
      if (!isFactorId(id) || typeof totp !== 'object' || totp === null) {
        return { ok: false, fault: 'malformed' };
      }
      const { qr_code: qrCode, secret, uri } = totp as Json;
      if (
        !isBoundedText(qrCode, 8192) ||
        !isBoundedText(secret, 128) ||
        !isBoundedText(uri, 1024)
      ) {
        return { ok: false, fault: 'malformed' };
      }
      return { ok: true, value: { factorId: id, qrCode, secret, uri } };
    },

    async verify(accessToken, factorId, code) {
      if (!isFactorId(factorId)) return { ok: false, fault: 'refused' };
      const challenge = await call('POST', `/factors/${factorId}/challenge`, accessToken, {});
      if (!challenge.ok) return challenge;
      const challengeId = challenge.value['id'];
      if (!isFactorId(challengeId)) return { ok: false, fault: 'malformed' };
      const verified = await call('POST', `/factors/${factorId}/verify`, accessToken, {
        challenge_id: challengeId,
        code,
      });
      if (!verified.ok) return verified;
      const access = verified.value['access_token'];
      const refresh = verified.value['refresh_token'];
      const expiresIn = verified.value['expires_in'];
      if (
        !isBoundedText(access, 8192) ||
        !isBoundedText(refresh, 512) ||
        !Number.isSafeInteger(expiresIn) ||
        (expiresIn as number) <= 0
      ) {
        return { ok: false, fault: 'malformed' };
      }
      return {
        ok: true,
        value: { accessToken: access, refreshToken: refresh, expiresIn: expiresIn as number },
      };
    },

    async remove(accessToken, factorId) {
      if (!isFactorId(factorId)) return { ok: false, fault: 'refused' };
      const answer = await call('DELETE', `/factors/${factorId}`, accessToken);
      if (!answer.ok) return answer;
      return answer.value['id'] === factorId
        ? { ok: true, value: undefined }
        : { ok: false, fault: 'malformed' };
    },

    // GoTrue's sign-out (C58): done is a 204 and nothing else, with nothing in
    // its body. A 200, a body of any kind or a refusal is not a sign-out.
    async signOut(accessToken, scope) {
      if (scope !== 'local' && scope !== 'others') return { ok: false, fault: 'refused' };
      const response = await request('POST', `/logout?scope=${scope}`, accessToken);
      if (!(response instanceof Response)) return { ok: false, fault: response.fault };
      const read = await readBounded(response, maxBytes, timeoutMs);
      if ('fault' in read) return { ok: false, fault: read.fault };
      if (response.status >= 400 && response.status < 500) return { ok: false, fault: 'refused' };
      if (response.status !== 204) return { ok: false, fault: 'unreachable' };
      return read.text === '' ? { ok: true, value: undefined } : { ok: false, fault: 'malformed' };
    },
  };
}

/** A provider identifier: the shape the `second_factors` row will accept. */
function isFactorId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value);
}

function isBoundedText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit;
}

export function isTimeout(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
}

/**
 * The body, up to `maxBytes`, counted as it arrives: a `content-length` is the
 * sender's claim and a chunked answer has none.
 */
export async function readBounded(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ readonly text: string } | { readonly fault: 'oversized' | 'slow' | 'unreachable' }> {
  const reader = response.body?.getReader();
  if (reader === undefined) return { text: '' };
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { fault: 'slow' };
      // One chunk at a time, each raced against what is left of the deadline.
      // oxlint-disable-next-line no-await-in-loop
      const next = await Promise.race([
        reader.read(),
        new Promise<'slow'>((resolve) => setTimeout(() => resolve('slow'), remaining).unref()),
      ]);
      if (next === 'slow') return { fault: 'slow' };
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) return { fault: 'oversized' };
      chunks.push(next.value);
    }
  } catch (cause) {
    return { fault: isTimeout(cause) ? 'slow' : 'unreachable' };
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)) };
}
