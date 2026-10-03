// SPDX-License-Identifier: AGPL-3.0-only
//
// The typed client. Every call the browser makes to the API goes through here,
// and the route it calls is derived rather than written down.
//
// **The route is `/api/b/:businessKey` + `pathOf(name)` and nothing else may compose it.**
// `pathOf` is imported from the command surface rather than reimplemented, so an operation renamed
// in the surface renames its route here in the same commit. A client with its own copy of the path
// rule is a second surface, and the whole point of the surface table is that there is one.
//
// **The business is in the path and never in the body.** It is named by the prefix and verified
// server-side by login resolution, so there is no field here for a caller to put a business in and
// no header this module will set that could carry one (checklist N7). The actor is likewise
// absent: the server takes it from the bearer token's subject.
//
// **`operationId` is minted here, per attempt, and a retry reuses it.** That is what makes the
// register's replay rule reachable from a browser: the same identity with the same payload returns
// the original result, and the same identity with a changed payload is the conflict
// `OPERATION_ID_REUSED` names. A client that minted a fresh identity on every retry could never
// exercise either, so `operationId` is an argument with a default, not a hidden value.
//
// **A session that has ended is reported from here, once, for every call.** The
// API answers a bearer it will not act on with HTTP 401 on one of two codes
// (`docs/local/API.md`): a missing, forged, unsigned or subject-less one is
// `AUTH_UNKNOWN_LOGIN`, and one whose signature verifies against this
// deployment's own secret and whose `exp` has passed is `AUTH_SESSION_EXPIRED`. Both mean the
// credential this client holds is no longer one, so both end the session here. A client that
// recognised only the first would leave a person whose hour ran out reading a raw refusal, with
// the sign-in path never offered. It arrives at whichever call happens to be next, so recognising
// it in each screen would be one rule written five times and forgotten in the sixth; here it is
// one signal, and `onSessionEnded` is how the application hears it. The refusal is still returned
// unchanged: reported, not swallowed.
//
// **Access ended is the third way a session ends (C58).** Ending a person's access deactivates
// their login and ends their memberships, but the bearer in the tab still verifies until its hour
// is up, so the API answers their next call 403 `AUTH_NO_MEMBERSHIP`. A login that was never a
// member gets the same answer on its first call, and that one is a denial to draw, not a session
// to end. So the client remembers whether its bearer has been answered as a member, by a success
// or by a refusal decided past login resolution (a scope not granted), and only a bearer that has
// been ends its session on it.
//
// The wire spells the envelope `operationId` and `expectedRevision`, camelCase,
// matching `commands/requests.ts`, though the slice contract's prose writes
// `operation_id`. There is one spelling on the wire and this is it.

import {
  ACCOUNT_AVAILABILITY_PATH,
  CSRF_HEADER,
  PREFIX,
  SESSION_HEADER,
  pathOf,
} from '../../../../packages/core-wire/src/index.ts';
import type { CommandName } from '../../../../packages/core-wire/src/index.ts';
import type { AccountRoute, NotARead, ReadName } from './read-names.ts';
import type {
  CallResult,
  CommandOutcome,
  FactorRemoved,
  FactorVerified,
  IssuedFactor,
  WireRefusal,
} from './results.ts';

export { READ_NAMES } from './read-names.ts';
export type { AccountRoute, NotARead, ReadName } from './read-names.ts';
export { isRefusal, isUnavailable } from './results.ts';
export type {
  CallResult,
  CommandOutcome,
  ConversationReply,
  FactorRemoved,
  FactorVerified,
  IssuedFactor,
  Unavailable,
  WireRefusal,
} from './results.ts';

export interface ClientOptions {
  /**
   * Where the API is served from: empty for the page's own origin, an absolute origin in a test.
   * The mount itself is `PREFIX.person`, the one the API serves and the command line sends to.
   */
  readonly origin: string;
  /** `alpha` or `bravo`. It is a path segment, not a claim in a body. */
  readonly businessKey: string;
  /** Signed in: the credential is the session cookie, which no script reads. */
  readonly signedIn: boolean;
  /** The id of this tab's sign-in: the API reads that session's cookie only. */
  readonly sessionId?: string;
  /** Injected so a test can drive the client without a network or a global. */
  readonly fetch: typeof globalThis.fetch;
  /** Injected for the same reason: a test needs a predictable operation id. */
  readonly newOperationId?: () => string;
  /**
   * The session this client was given is one the API will not vouch for.
   *
   * Called only when signed in: a 401 with no session is a call nobody was
   * signed in for, and ending a session never held reports nothing that happened.
   */
  readonly onSessionEnded?: (refusal: WireRefusal) => void;
}

export interface MutationOptions {
  /** Reused across retries on purpose. See the note at the top of this file. */
  readonly operationId?: string;
  /** Required by the server on a write against an existing record. */
  readonly expectedRevision?: number;
}

export class OperationsClient {
  readonly #options: ClientOptions;
  /** Whether this bearer has had an answer only a member here gets. */
  #answered = false;

  constructor(options: ClientOptions) {
    this.#options = options;
  }

  /** The business this client speaks to. Fixed at construction, as the path is. */
  get businessKey(): string {
    return this.#options.businessKey;
  }

  /** A fresh attempt identity. Held by the caller so a retry can present it again. */
  newOperationId(): string {
    const mint = this.#options.newOperationId;
    return mint === undefined ? crypto.randomUUID() : mint();
  }

  /**
   * A read. No `operationId` and no `expectedRevision`: a read has no attempt
   * to be idempotent about and no revision to be stale against.
   */
  async read<T>(name: ReadName, body: Readonly<Record<string, unknown>>): Promise<CallResult<T>> {
    return await this.#post<T>(pathOf(name), body);
  }

  /**
   * A mutation. `operationId` is always sent; `expectedRevision` is sent when
   * the caller has one and omitted when it does not, so that the server's
   * `EXPECTED_REVISION_REQUIRED` stays reachable from this surface rather than
   * being pre-empted by a client-side guess.
   */
  async mutate<Name extends CommandName>(
    name: NotARead<Name>,
    body: Readonly<Record<string, unknown>>,
    options: MutationOptions = {},
  ): Promise<CallResult<CommandOutcome>> {
    const operationId = options.operationId ?? this.newOperationId();
    const payload: Record<string, unknown> = { ...body, operationId };
    if (options.expectedRevision !== undefined) {
      payload['expectedRevision'] = options.expectedRevision;
    }
    return await this.#post<CommandOutcome>(pathOf(name), payload);
  }

  /** The person's own account route (C58), always with an empty body: see `AccountRoute`. */
  async account<T>(route: AccountRoute): Promise<CallResult<T>> {
    return await this.#post<T>(`/account/${route}`, {});
  }

  /**
   * The person's authenticator code checked on their own account route (C59): the one account
   * call with a body. A good code on a verified factor is a step-up and answers a new token.
   */
  async verifyFactor(code: string): Promise<CallResult<FactorVerified>> {
    return await this.#post<FactorVerified>('/account/factor/verify', { code });
  }

  /**
   * A new authenticator app for the person (C59), on their own account route with an empty body:
   * the server takes the person from the credential. The first good code completes it.
   */
  async enrolFactor(): Promise<CallResult<IssuedFactor>> {
    return await this.#post<IssuedFactor>('/account/factor/enrol', {});
  }

  /** The authenticator app removed (C59) with its current code; the person's other sessions end. */
  async removeFactor(code: string): Promise<CallResult<FactorRemoved>> {
    return await this.#post<FactorRemoved>('/account/factor/remove', { code });
  }

  /** The person's own availability (MP-7-10), on the path the surface names. */
  setAvailability(body: Readonly<Record<string, unknown>>): Promise<CallResult<unknown>> {
    return this.#post(ACCOUNT_AVAILABILITY_PATH, body);
  }

  /** One live stream naming every topic (C4), or nothing if the join is refused or unreachable. */
  async openLive(
    topics: readonly string[],
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array> | null> {
    const query = topics.map((topic) => `topic=${encodeURIComponent(topic)}`).join('&');
    return (await this.#live(`?${query}`, { signal }))?.body ?? null;
  }

  /** A presence route under `live/` (C2), its JSON when it answered 2xx, else null. */
  async live(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.#live(`/${path}`, init);
    return response === null ? null : await response.json().catch(() => null);
  }

  /** The live channel at `path`, sent and its refusal heard as `#post`'s are: 2xx, else null. */
  async #live(path: string, init: RequestInit): Promise<Response | null> {
    const { origin, businessKey, sessionId } = this.#options;
    const url = `${origin}${PREFIX.person}${encodeURIComponent(businessKey)}/live${path}`;
    const headers = new Headers(init.headers);
    headers.set(CSRF_HEADER, '1');
    if (sessionId !== undefined) headers.set(SESSION_HEADER, sessionId);
    try {
      const response = await this.#options.fetch(url, { ...init, headers });
      if (response.ok) return response;
      const parsed: unknown = await response.json().catch(() => {});
      if (isWireRefusal(parsed)) this.#heard(response.status, parsed);
      return null;
    } catch {
      return null;
    }
  }

  async #post<T>(path: string, body: Readonly<Record<string, unknown>>): Promise<CallResult<T>> {
    const url = `${this.#options.origin}${PREFIX.person}${encodeURIComponent(this.#options.businessKey)}${path}`;
    // The browser's cookie (S0-6c) is the only credential; no actor, business or forwarded
    // header for a tampered request to reach (N7).
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      [CSRF_HEADER]: '1',
    };
    if (this.#options.sessionId !== undefined) headers[SESSION_HEADER] = this.#options.sessionId;

    let response: Response;
    try {
      response = await this.#options.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (error) {
      // A transport failure is unavailable and is never dressed as a refusal.
      // The two are different facts and the screens draw them differently.
      return { unavailable: true, because: describe(error) };
    }

    const parsed: unknown = await response.json().catch(() => {});

    if (isWireRefusal(parsed)) {
      this.#heard(response.status, parsed);
      return parsed;
    }

    if (!response.ok) {
      // A non-2xx with no refusal body is the server failing, not refusing.
      // Saying "denied" here would invent an authority decision nobody made.
      return { unavailable: true, because: `The API answered ${String(response.status)}.` };
    }
    if (parsed === undefined) {
      return { unavailable: true, because: 'The API answered with something that was not JSON.' };
    }
    this.#answered = true;
    return { ok: true, value: parsed as T };
  }

  #heard(status: number, refusal: WireRefusal): void {
    const revoked = status === 403 && refusal.code === 'AUTH_NO_MEMBERSHIP' && this.#answered;
    const ends = status === 401 ? SESSION_ENDED.has(refusal.code) : revoked;
    if (ends && this.#options.signedIn) this.#options.onSessionEnded?.(refusal);
    if (status !== 401 && !BEFORE_LOGIN.has(refusal.code)) this.#answered = true;
  }
}

/**
 * The two codes that mean the bearer is no longer a credential.
 *
 * Paired with the 401 rather than trusted alone: the code names the decision
 * and the status names the boundary that made it, and a 403 carrying either of
 * these would be a different answer than the one this rule is about.
 *
 * They are two because the API tells them apart on purpose (`AUTH_UNKNOWN_LOGIN`
 * says nothing of which guess was closer; `AUTH_SESSION_EXPIRED` goes only to a
 * bearer this deployment signed). The difference is for the reader, not this client.
 */
const SESSION_ENDED = new Set(['AUTH_UNKNOWN_LOGIN', 'AUTH_SESSION_EXPIRED']);

/** Refusals besides the 401s that can come before login resolution places a member. */
const BEFORE_LOGIN = new Set([
  'AUTH_NO_MEMBERSHIP',
  'ACTOR_INACTIVE',
  'AUTH_CROSS_SITE',
  'AUTH_SESSION_MISMATCH',
  'COMMAND_BODY_INVALID',
]);

function isWireRefusal(value: unknown): value is WireRefusal {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return body['refused'] === true && typeof body['code'] === 'string';
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : 'The request did not reach the API.';
