// SPDX-License-Identifier: AGPL-3.0-only
//
// Which credential may carry which call (AW-01, LF-5, C60 lines 51 and 52).
//
// Four kinds are recorded on every call: a subscription held by a person, an
// API key, a cloud provider credential, and `replay` for the stand-in provider.
// Custody stores only the last three. A subscription is never stored; which
// calls one may carry is `carry-rule.ts`. A Claude.ai or ChatGPT session token
// is refused at load, whatever kind it is filed under.

export type CredentialKind = 'subscription' | 'api_key' | 'cloud_credential' | 'replay';
export type StorableKind = Exclude<CredentialKind, 'subscription'>;

export interface StoredCredential {
  readonly ref: string;
  readonly kind: StorableKind;
  /** The account that carries the call; none for `replay`. */
  readonly account: string | null;
  /** The one destination this credential may be sent to. */
  readonly destination: string;
  readonly header: 'authorization' | 'x-api-key';
  /**
   * How an `authorization` value is presented: `bearer` (the default), or
   * `basic` for a `user:secret` pair sent as HTTP Basic, as the trace
   * target's project route takes it (AW-13). `none` is a destination that
   * asks for no key (Ollama on loopback): it is filed with no header and no
   * value and presented as nothing, so the answer holds no secret to echo
   * and custody may pass it on as it arrives.
   */
  readonly scheme: 'bearer' | 'basic' | 'none';
  readonly value: string;
}

export type CredentialRefusal =
  'CREDENTIAL_NOT_STORABLE' | 'SESSION_TOKEN_REFUSED' | 'CREDENTIAL_MALFORMED';

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
function isSessionToken(value: string): boolean {
  return readings(value).some(
    (text) =>
      SESSION_TOKEN.some((pattern) => pattern.test(text)) ||
      text.split(SEPARATOR).some((piece) => isEncryptedToken(piece)),
  );
}

const REF = /^[a-z][a-z0-9_]{0,62}$/u;

/** A Basic pair: one colon, a user, and a secret of 8 or more; the value holds no space. */
const PAIR = /^[^:]+:[^:]{8,}$/u;

/** A `none` entry: no header and no value, a stored kind and its account, or undefined. */
function presentedAsNothing(
  shape: Record<string, unknown>,
  credentials: ReadonlyMap<string, StoredCredential>,
): StoredCredential | undefined {
  const { ref, kind, account, destination } = shape;
  if (
    'header' in shape ||
    'value' in shape ||
    typeof ref !== 'string' ||
    !REF.test(ref) ||
    credentials.has(ref) ||
    (kind !== 'api_key' && kind !== 'cloud_credential') ||
    typeof destination !== 'string' ||
    !REF.test(destination) ||
    typeof account !== 'string' ||
    account === ''
  ) {
    return undefined;
  }
  return { ref, kind, account, destination, header: 'authorization', scheme: 'none', value: '' };
}

/** One entry of the list as a stored credential, or why it is refused. */
function credentialOf(
  shape: Record<string, unknown>,
  credentials: ReadonlyMap<string, StoredCredential>,
): StoredCredential | CredentialRefusal {
  const { ref, kind, account, destination, header, value } = shape;
  // Absent only: JSON has no undefined, so a null or empty scheme is malformed.
  const scheme = 'scheme' in shape ? shape['scheme'] : 'bearer';
  if (kind === 'subscription') return 'CREDENTIAL_NOT_STORABLE';
  if (scheme === 'none') return presentedAsNothing(shape, credentials) ?? 'CREDENTIAL_MALFORMED';
  if (typeof value === 'string' && isSessionToken(value)) return 'SESSION_TOKEN_REFUSED';
  if (
    typeof ref !== 'string' ||
    !REF.test(ref) ||
    credentials.has(ref) ||
    (kind !== 'api_key' && kind !== 'cloud_credential' && kind !== 'replay') ||
    typeof destination !== 'string' ||
    !REF.test(destination) ||
    (header !== 'authorization' && header !== 'x-api-key') ||
    (scheme !== 'bearer' && scheme !== 'basic') ||
    (scheme === 'basic' && header !== 'authorization') ||
    typeof value !== 'string' ||
    (scheme === 'basic' && !PAIR.test(value)) ||
    value.length < 8 ||
    /[\s\0]/u.test(value) ||
    (kind === 'replay' ? account !== null : typeof account !== 'string' || account === '')
  ) {
    return 'CREDENTIAL_MALFORMED';
  }
  return { ref, kind, account: account as string | null, destination, header, scheme, value };
}

/**
 * Read custody's credential list, refusing the whole list on any bad entry.
 * A refusal names the entry's position and why, and never its value.
 */
export function parseCredentials(
  entries: unknown,
):
  | { readonly ok: true; readonly credentials: ReadonlyMap<string, StoredCredential> }
  | { readonly ok: false; readonly code: CredentialRefusal; readonly at: number } {
  if (!Array.isArray(entries)) return { ok: false, code: 'CREDENTIAL_MALFORMED', at: -1 };
  const credentials = new Map<string, StoredCredential>();
  for (const [at, entry] of entries.entries()) {
    if (typeof entry !== 'object' || entry === null)
      return { ok: false, code: 'CREDENTIAL_MALFORMED', at };
    const read = credentialOf(entry as Record<string, unknown>, credentials);
    if (typeof read === 'string') return { ok: false, code: read, at };
    credentials.set(read.ref, read);
  }
  return { ok: true, credentials };
}

/** The header value a stored credential is sent as. */
export function presented(
  credential: Pick<StoredCredential, 'header' | 'scheme' | 'value'>,
): string {
  const { header, scheme, value } = credential;
  if (header === 'x-api-key') return value;
  return scheme === 'basic' ? `Basic ${Buffer.from(value).toString('base64')}` : `Bearer ${value}`;
}

/**
 * Custody's answer to a describe: the kind and account of the credential it
 * holds for `destination`, never its value, which the broker records before a
 * send (catalogue #439); refused when it holds no such credential there,
 * exactly as a dispatch would be.
 */
export function described(
  credential: StoredCredential | undefined,
  destination: unknown,
): Record<string, unknown> {
  if (credential === undefined || credential.destination !== destination) {
    return { type: 'refused', code: 'CUSTODY_CREDENTIAL_UNKNOWN' };
  }
  // Whether it is sent at all: an answer to one that is sent may echo it, so is never streamed.
  const presents = credential.scheme !== 'none';
  return {
    type: 'described',
    kind: credential.kind,
    account: credential.account,
    presents,
    scheme: credential.scheme,
  };
}
