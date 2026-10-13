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
// LA-1's carve-out (#859, owner 1 October 2026; GPT in Claude's place, owner
// 7 October): on the owner's laptop, with the `local-gpt` provider, a
// subscription may carry unattended work (a scheduled job, a task's agent run)
// for the owner's own testing on made-up data. The broker sets
// `localOwnerTesting` only when the API's composition root accepted
// `OPS_AGENT_PROVIDER=local-gpt`, which it does only under
// `OPS_ENVIRONMENT=local`, and only for a route whose provider is
// `local_gpt`. Another installation's tenant stays refused under it, and so
// does an attended call for someone else's work. Everywhere else, unchanged.
//
// The owner's ChatGPT plan (#1620): custody on the owner's machine files one
// subscription, the owner's own refreshable sign-in, by its token file and
// the sign-in destination that refreshes it (`plan-token.ts`), never by a
// value. Its route carries a run only when the owner started it, attended or
// not; any other run is refused `SUBSCRIPTION_NOT_OWNER_STARTED`.

import { isSessionToken } from './session-token.ts';

export type CredentialKind = 'subscription' | 'api_key' | 'cloud_credential' | 'replay';

export type StorableKind = Exclude<CredentialKind, 'subscription'>;

export interface StoredCredential {
  readonly ref: string;
  /** A subscription only as the owner's plan sign-in (`oauth_refresh`). */
  readonly kind: CredentialKind;
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
   * and custody may pass it on as it arrives. `oauth_refresh` is the
   * owner's plan sign-in: no value is filed, and custody presents the token
   * file's current access token as a bearer.
   */
  readonly scheme: 'bearer' | 'basic' | 'none' | 'oauth_refresh';
  readonly value: string;
  /** For `oauth_refresh`: the owner-only file the sign-in wrote, a whole path. */
  readonly tokenFile?: string;
  /** For `oauth_refresh`: the destination whose token endpoint refreshes it. */
  readonly refreshDestination?: string;
}

export type CredentialRefusal =
  'CREDENTIAL_NOT_STORABLE' | 'SESSION_TOKEN_REFUSED' | 'CREDENTIAL_MALFORMED';

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

/** The owner's plan sign-in: a subscription with a token file and a refresh destination, and no value. */
function refreshableSignIn(
  shape: Record<string, unknown>,
  credentials: ReadonlyMap<string, StoredCredential>,
): StoredCredential | undefined {
  const { ref, kind, account, destination, tokenFile, refreshDestination } = shape;
  if (
    'header' in shape ||
    'value' in shape ||
    kind !== 'subscription' ||
    typeof ref !== 'string' ||
    !REF.test(ref) ||
    credentials.has(ref) ||
    typeof destination !== 'string' ||
    !REF.test(destination) ||
    typeof refreshDestination !== 'string' ||
    !REF.test(refreshDestination) ||
    typeof tokenFile !== 'string' ||
    !tokenFile.startsWith('/') ||
    /[\s\0]/u.test(tokenFile) ||
    typeof account !== 'string' ||
    account === ''
  ) {
    return undefined;
  }
  return {
    ref,
    kind,
    account,
    destination,
    header: 'authorization',
    scheme: 'oauth_refresh',
    value: '',
    tokenFile,
    refreshDestination,
  };
}

/** One entry of the list as a stored credential, or why it is refused. */
function credentialOf(
  shape: Record<string, unknown>,
  credentials: ReadonlyMap<string, StoredCredential>,
): StoredCredential | CredentialRefusal {
  const { ref, kind, account, destination, header, value } = shape;
  // Absent only: JSON has no undefined, so a null or empty scheme is malformed.
  const scheme = 'scheme' in shape ? shape['scheme'] : 'bearer';
  if (scheme === 'oauth_refresh') {
    return refreshableSignIn(shape, credentials) ?? 'CREDENTIAL_MALFORMED';
  }
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
  /** LA-1's local carve-out: true only on the laptop, on a `local_gpt` route. */
  readonly localOwnerTesting?: boolean;
  /** Present only on the owner's plan route (`planCarry`). */
  readonly plan?: { readonly ownerStarted: boolean } | undefined;
}

export type CarryRefusal =
  | 'SUBSCRIPTION_UNATTENDED'
  | 'SUBSCRIPTION_OTHER_TENANT'
  | 'SUBSCRIPTION_NOT_OWN_WORK'
  | 'SUBSCRIPTION_NOT_OWNER_STARTED';

/**
 * The owner's plan provider key (`CHATGPT_PLAN_PROVIDER` in core-connectors),
 * written out here for the same reason as the local session's; a test holds
 * the two equal.
 */
export const CHATGPT_PLAN_PROVIDER = 'chatgpt_plan';

/**
 * The plan's part of the carry context: on the plan's route only, whether the
 * run works for the plan's owner as the broker's setting names them. Unset,
 * no run is the owner's.
 */
export function planCarry(
  broker: { readonly planOwnerPersonId?: string },
  route: { readonly provider: string },
  workForPersonId: string | null,
): { readonly ownerStarted: boolean } | undefined {
  if (route.provider !== CHATGPT_PLAN_PROVIDER) return undefined;
  const owner = broker.planOwnerPersonId;
  return { ownerStarted: owner !== undefined && owner !== '' && workForPersonId === owner };
}

/**
 * The local session's provider key (`LOCAL_GPT_PROVIDER` in core-connectors).
 * Written out here because custody's process loads this file and no connector
 * code (AW-01 custody 9); a test holds the two equal.
 */
export const LOCAL_SESSION_PROVIDER = 'local_gpt';

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
  // The plan's route is the owner's whatever its credential is filed as.
  if (context.plan === undefined && kind !== 'subscription') return { ok: true };
  if (context.tenantInstallation !== context.credentialInstallation) {
    return { ok: false, code: 'SUBSCRIPTION_OTHER_TENANT' };
  }
  if (context.plan !== undefined) {
    return context.plan.ownerStarted
      ? { ok: true }
      : { ok: false, code: 'SUBSCRIPTION_NOT_OWNER_STARTED' };
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
  return { type: 'described', kind: credential.kind, account: credential.account, presents };
}
