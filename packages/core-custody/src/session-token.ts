// SPDX-License-Identifier: AGPL-3.0-only
//
// Whether a value is, or carries, a consumer chat product's browser session
// token: never stored by custody (AW-01, C60), whatever kind it is filed
// under. Moved out of `credentials.ts` unchanged.

/** What can stand between one token and the next in a pasted value. */
const SEPARATOR = /[\s"'&,:;=\u200B-\u200D\u2060]/u;

/**
 * Shapes of a browser session token for a consumer chat product, or of the
 * cookie that carries one. Never stored. Matched anywhere in the value, so a
 * pasted cookie pair (`sessionKey=sk-ant-sid01-...`) is caught as well as the
 * bare token. A `sess-` token, or an encrypted one, is matched where a token
 * can start: the value's start, or after a separator (`SEPARATOR`), such as a
 * Basic pair's colon, a cookie's `=` or `;`, a query's `&`, a quote, white
 * space or a zero-width character.
 */
const SESSION_TOKEN = [
  /sk-ant-sid/iu,
  new RegExp(`(?:^|${SEPARATOR.source})sess-`, 'iu'),
  /sessionkey/iu,
  /session[-_]?token/iu,
  /__secure-next-auth/iu,
];

/** Printable text, as a base64 value that is really an encoded pair decodes to. */
const PRINTABLE = /^[\u0020-\u007E]+$/u;

/**
 * The value and each percent-decoding of it, until decoding changes nothing;
 * and, for a value wholly base64 or base64url (a Basic header's encoded pair
 * pasted alone), its decoding when that is printable text.
 */
function readings(value: string): readonly string[] {
  const seen = [value];
  if (/^[\w+/-]+={0,2}$/u.test(value)) {
    const decoded = Buffer.from(value, 'base64').toString('latin1');
    if (PRINTABLE.test(decoded)) seen.push(decoded);
  }
  for (let round = 0; round < 3; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(seen.at(-1) ?? value);
    } catch {
      break;
    }
    if (next === seen.at(-1)) break;
    seen.push(next);
  }
  return seen;
}

/**
 * An encrypted token in compact form: five base64url parts, the first a
 * header naming its content encryption. The chat product's sign-in library
 * writes its session cookie so; an API key or a signed cloud token never is.
 */
function isEncryptedToken(text: string): boolean {
  const parts = text.split('.');
  if (parts.length !== 5 || !parts.every((part) => /^[\w-]*$/u.test(part))) return false;
  try {
    const header: unknown = JSON.parse(Buffer.from(parts[0] ?? '', 'base64url').toString('utf8'));
    return typeof header === 'object' && header !== null && 'enc' in header;
  } catch {
    return false;
  }
}

/** Whether a value is, or carries, a consumer chat product's browser session. */
export function isSessionToken(value: string): boolean {
  return readings(value).some(
    (text) =>
      SESSION_TOKEN.some((pattern) => pattern.test(text)) ||
      text.split(SEPARATOR).some((piece) => isEncryptedToken(piece)),
  );
}
