// SPDX-License-Identifier: AGPL-3.0-only
//
// Which credential may carry which call (AW-01, LF-5, C60 lines 51 and 52).
//
// Four kinds are recorded on every call: a subscription held by a person, an
// API key, a cloud provider credential, and `replay` for the stand-in provider.
// Custody stores only the last three. A subscription is never stored: it is
// usable only in a person's own session for that person's own work, so an
// unattended run, a run for someone else, or a call for another installation's
// tenant is refused by name. A Claude.ai or ChatGPT session token is refused
// at load, whatever kind it is filed under.
//
// LA-1's carve-out (#859, owner 1 October 2026): on the owner's laptop, with
// the `local-claude` provider, a subscription may carry unattended work (a
// scheduled job, a task's agent run) for the owner's own testing on made-up
// data. The broker sets `localOwnerTesting` only when the API's composition
// root accepted `OPS_AGENT_PROVIDER=local-claude`, which it does only under
// `OPS_ENVIRONMENT=local`, and only for a route whose provider is
// `local-claude`. Another installation's tenant stays refused under it, and so
// does an attended call for someone else's work. Everywhere else, unchanged.

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
   * target's project route takes it (AW-13).
   */
  readonly scheme: 'bearer' | 'basic';
  readonly value: string;
}

export type CredentialRefusal =
  'CREDENTIAL_NOT_STORABLE' | 'SESSION_TOKEN_REFUSED' | 'CREDENTIAL_MALFORMED';

/**
 * Shapes of a browser session token for a consumer chat product, or of the
 * cookie that carries one. Never stored. Matched anywhere in the value, so a
 * pasted cookie pair (`sessionKey=sk-ant-sid01-...`) is caught as well as the
 * bare token.
 */
const SESSION_TOKEN = [
  /sk-ant-sid/iu,
  /^sess-/iu,
  /sessionkey/iu,
  /session[-_]?token/iu,
  /__secure-next-auth/iu,
];

/** The value and each percent-decoding of it, until decoding changes nothing. */
function readings(value: string): readonly string[] {
  const seen = [value];
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
      text.split(/[=;]/u).some((piece) => isEncryptedToken(piece)),
  );
}

const REF = /^[a-z][a-z0-9_]{0,62}$/u;

/** A Basic pair: one colon, a user, and a secret of 8 or more; the value holds no space. */
const PAIR = /^[^:]+:[^:]{8,}$/u;

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
    const shape = entry as Record<string, unknown>;
    const { ref, kind, account, destination, header, value } = shape;
    // Absent only: JSON has no undefined, so a null or empty scheme is malformed.
    const scheme = 'scheme' in shape ? shape['scheme'] : 'bearer';
    if (kind === 'subscription') return { ok: false, code: 'CREDENTIAL_NOT_STORABLE', at };
    if (typeof value === 'string' && isSessionToken(value)) {
      return { ok: false, code: 'SESSION_TOKEN_REFUSED', at };
    }
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
      return { ok: false, code: 'CREDENTIAL_MALFORMED', at };
    }
    credentials.set(ref, {
      ref,
      kind,
      account: account as string | null,
      destination,
      header,
      scheme,
      value,
    });
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

export interface CarryContext {
  /** No person is present in their own session for this call. */
  readonly unattended: boolean;
  /** The person whose session presents the credential, if any. */
  readonly sessionPersonId: string | null;
  /** The person the run works for. */
  readonly workForPersonId: string | null;
  /** The installation the call's tenant belongs to, and the credential's own. */
  readonly tenantInstallation: string;
  readonly credentialInstallation: string;
  /** LA-1's local carve-out: true only on the laptop, on a `local-claude` route. */
  readonly localOwnerTesting?: boolean;
}

export type CarryRefusal =
  'SUBSCRIPTION_UNATTENDED' | 'SUBSCRIPTION_OTHER_TENANT' | 'SUBSCRIPTION_NOT_OWN_WORK';

/**
 * The local session's provider key (`LOCAL_CLAUDE_PROVIDER` in core-connectors).
 * Written out here because custody's process loads this file and no connector
 * code (AW-01 custody 9); a test holds the two equal.
 */
export const LOCAL_SESSION_PROVIDER = 'local_claude';

/** LA-1's carve-out applies: the broker carries it, and the route is the local session's. */
export function carriesLocally(
  broker: { readonly localOwnerTesting?: boolean },
  route: { readonly provider: string },
): boolean {
  return broker.localOwnerTesting === true && route.provider === LOCAL_SESSION_PROVIDER;
}

/** A subscription carries only a person's own attended work in their own installation. */
export function mayCarry(
  kind: CredentialKind,
  context: CarryContext,
): { readonly ok: true } | { readonly ok: false; readonly code: CarryRefusal } {
  if (kind !== 'subscription') return { ok: true };
  if (context.tenantInstallation !== context.credentialInstallation) {
    return { ok: false, code: 'SUBSCRIPTION_OTHER_TENANT' };
  }
  const unattended = context.unattended || context.sessionPersonId === null;
  // Under the carve-out an unattended call has no session to compare its work with.
  if (unattended) {
    return context.localOwnerTesting === true
      ? { ok: true }
      : { ok: false, code: 'SUBSCRIPTION_UNATTENDED' };
  }
  if (context.workForPersonId !== context.sessionPersonId) {
    return { ok: false, code: 'SUBSCRIPTION_NOT_OWN_WORK' };
  }
  return { ok: true };
}
