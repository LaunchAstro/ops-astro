// SPDX-License-Identifier: AGPL-3.0-only
//
// The provider's delivery and bounce events (AW-07b hook signature). Resend
// posts them signed the Svix way: three headers, `svix-id`, `svix-timestamp`
// and `svix-signature`, and an HMAC-SHA256 under the hook secret over
// `<id>.<timestamp>.<raw body>`.
//
// The order is the rule. The headers are read strictly (one value each, no
// list a proxy joined), the signature is checked over the body's raw bytes,
// and only then is the body decoded and parsed. A body altered after signing,
// re-encoded, or signed under another secret is refused before a byte of it
// is read as JSON. A timestamp more than five minutes either side of now is
// refused, so a captured event cannot be played later; a replayed id inside
// the window is refused where the event lands (`broker-email-hook.ts`).
//
// What survives is three values: the event's id, its type and the provider's
// message id. The rest of the body (the recipient's address, the subject) is
// never kept, returned or logged.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far a timestamp may sit from now, either side, in seconds. */
export const EMAIL_HOOK_TOLERANCE_S: number = 5 * 60;

/** The largest event body read at all. */
export const EMAIL_HOOK_MAX_BYTES: number = 64 * 1024;

export type EmailHookRefusal = 'HOOK_HEADERS' | 'HOOK_STALE' | 'HOOK_SIGNATURE' | 'HOOK_MALFORMED';

/** A verified event: what it is, which event it is, and which message it is about. */
export interface EmailHookEvent {
  readonly id: string;
  readonly type: string;
  readonly messageId: string;
}

export type EmailHookVerdict =
  | { readonly ok: true; readonly event: EmailHookEvent }
  | { readonly ok: false; readonly code: EmailHookRefusal };

/** A header by name: one value, or undefined. A repeated header arrives comma-joined. */
export type HeaderOf = (name: string) => string | null | undefined;

const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const TIMESTAMP = /^[0-9]{1,12}$/u;
const SIGNATURE = /^v1,[A-Za-z0-9+/]{43}=$/u;
const SECRET = /^whsec_[A-Za-z0-9+/]{24,}={0,2}$/u;
const MESSAGE_ID = /^[A-Za-z0-9-]{1,64}$/u;
const TYPE = /^[a-z_]{1,32}\.[a-z_]{1,32}$/u;

/** The hook secret's key bytes, or undefined for a secret not in the provider's form. */
function keyOf(secret: string): Buffer | undefined {
  return SECRET.test(secret) ? Buffer.from(secret.slice('whsec_'.length), 'base64') : undefined;
}

/** The three headers, each exactly one well-formed value, or undefined. */
function headersOf(
  header: HeaderOf,
): { id: string; timestamp: string; signatures: string[] } | undefined {
  const id = header('svix-id');
  const timestamp = header('svix-timestamp');
  const signature = header('svix-signature');
  if (typeof id !== 'string' || !EVENT_ID.test(id)) return undefined;
  if (typeof timestamp !== 'string' || !TIMESTAMP.test(timestamp)) return undefined;
  if (typeof signature !== 'string') return undefined;
  // Several signatures are space-separated; every one must be well formed, so
  // a comma-joined repeat of the header is refused whole.
  const signatures = signature.split(' ');
  if (signatures.length > 8 || !signatures.every((one) => SIGNATURE.test(one))) return undefined;
  return { id, timestamp, signatures: signatures.map((one) => one.slice(3)) };
}

/** The HMAC over the raw bytes, compared in constant time with each presented signature. */
function signed(
  key: Buffer,
  id: string,
  timestamp: string,
  raw: Uint8Array,
  presented: string[],
): boolean {
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(raw).digest();
  return presented.some((one) => {
    const given = Buffer.from(one, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** The event from a verified body: strict UTF-8, one JSON object, a known shape. */
function eventOf(id: string, raw: Uint8Array): EmailHookEvent | undefined {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw));
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const { type, data } = body as Record<string, unknown>;
  if (typeof type !== 'string' || !TYPE.test(type)) return undefined;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const messageId = (data as Record<string, unknown>)['email_id'];
  if (typeof messageId !== 'string' || !MESSAGE_ID.test(messageId)) return undefined;
  return { id, type, messageId };
}

/**
 * Verify one event: the headers, the timestamp, the signature over the raw
 * body, and only then the body's shape. `nowSeconds` is the server's clock.
 */
export function verifyEmailHook(
  raw: Uint8Array,
  header: HeaderOf,
  secret: string,
  nowSeconds: number,
): EmailHookVerdict {
  const key = keyOf(secret);
  const headers = headersOf(header);
  if (key === undefined || headers === undefined || raw.byteLength > EMAIL_HOOK_MAX_BYTES) {
    return { ok: false, code: 'HOOK_HEADERS' };
  }
  if (Math.abs(nowSeconds - Number(headers.timestamp)) > EMAIL_HOOK_TOLERANCE_S) {
    return { ok: false, code: 'HOOK_STALE' };
  }
  if (!signed(key, headers.id, headers.timestamp, raw, headers.signatures)) {
    return { ok: false, code: 'HOOK_SIGNATURE' };
  }
  const event = eventOf(headers.id, raw);
  return event === undefined ? { ok: false, code: 'HOOK_MALFORMED' } : { ok: true, event };
}
