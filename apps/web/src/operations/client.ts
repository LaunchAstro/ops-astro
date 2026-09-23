// SPDX-License-Identifier: AGPL-3.0-only
//
// The typed client. Every call the browser makes to the API goes through here,
// and the route it calls is derived rather than written down.
//
// **The route is `/api/b/:businessKey` + `pathOf(name)` and nothing else may
// compose it.** `pathOf` is imported from the command surface rather than
// reimplemented, so an operation renamed in the surface renames its route here
// in the same commit. A client with its own copy of the path rule is a second
// surface, and the whole point of the surface table is that there is one.
//
// **The business is in the path and never in the body.** It is named by the
// prefix and verified server-side by login resolution, so there is no field
// here for a caller to put a business in and no header this module will set
// that could carry one (checklist N7). The actor is likewise absent: the server
// takes it from the bearer token's subject.
//
// **`operationId` is minted here, per attempt, and a retry reuses it.** That
// is what makes the register's replay rule reachable from a browser: the same
// identity with the same payload returns the original result, and the same
// identity with a changed payload is the conflict `OPERATION_ID_REUSED` names.
// A client that minted a fresh identity on every retry could never exercise
// either, so `operationId` is an argument with a default, not a hidden value.
//
// **A session that has ended is reported from here, once, for every call.** The
// API answers a bearer it will not act on with HTTP 401 on one of two codes
// (`docs/local/API.md`): a missing, forged, unsigned or subject-less one is
// `AUTH_UNKNOWN_LOGIN`, and one whose signature verifies against this
// deployment's own secret and whose `exp` has passed is `AUTH_SESSION_EXPIRED`.
// Both mean the credential this client holds is no longer one, so both end the
// session here. A client that recognised only the first would leave a person
// whose hour ran out reading a raw refusal on whichever screen they were on,
// with the sign-in path never offered. A token lives an
// hour, so this arrives at an ordinary moment in an ordinary day, and it
// arrives at whichever call happened to be next — a board read, a task read, a
// save. Recognising it in each screen would be the same rule written five times
// and forgotten in the sixth; recognising it here is one signal in one place,
// and `onSessionEnded` is how the application hears it. The refusal is still
// returned unchanged: this module reports, it does not swallow.
//
// The wire spells the envelope `operationId` and `expectedRevision`, camelCase,
// matching the draft's `commands/requests.ts`. The slice contract named it in
// prose as `operation_id` and the coordinator ruled on the camelCase spelling
// at 22:53Z; there is one spelling on the wire and this is it.

import {
  pathOf,
  type CommandName,
} from '../../../../packages/core-records/src/commands/surface.ts';

/**
 * The reads the contract adds to the surface, named here as their own type.
 *
 * They are declared in `COMMAND_SURFACE` with `kind: 'read'` by the lane that
 * owns `packages/core-records`. This union exists so that this lane's files
 * typecheck against the surface as it stands today and keep their meaning when
 * the read declarations land: the names are the same strings either way, and
 * `operationPath` below derives all of them through the one `pathOf`.
 *
 * It cannot drift from the server unnoticed: `tests/surfaces/read-names.test.ts`
 * holds that every name here is declared on `COMMAND_SURFACE` with
 * `kind: 'read'`. A name the server does not declare fails that case rather
 * than reaching a route at runtime and 404ing in front of a person. The names
 * are an array and the union is read off it, so the list the case walks is the
 * list the type is made of rather than a copy of it kept in step by hand.
 */
export const READ_NAMES = [
  'task.read',
  'task.board',
  'person.list',
  'settings.read',
  'session.capabilities',
] as const;

export type ReadName = (typeof READ_NAMES)[number];

export type OperationName = CommandName | ReadName;

/** The one route rule, for both halves of the surface. */
export function operationPath(name: OperationName): string {
  return pathOf(name as CommandName);
}

/** What a mutation returns when it worked: a durable handle and a new revision. */
export interface CommandOutcome {
  readonly recordId: string;
  readonly revision: number;
  /**
   * Whatever the operation has to say about what it did, in its own words.
   *
   * It is the envelope's third field (`commands/outcome.ts`) and the API passes
   * it through unchanged. `task.comment` puts the new comment's identifier in
   * it; the two settings commands put the key and the value the row now holds,
   * which is the only thing in this build that tells a caller what a setting
   * was set to — there is no settings read. Optional, because most operations
   * have nothing to add beyond the handle and the revision.
   */
  readonly detail?: Readonly<Record<string, unknown>>;
}

/**
 * A refusal as it arrives over HTTP.
 *
 * This is the wire shape, deliberately declared here rather than imported from
 * the domain: the browser parses JSON that crossed a network, and typing it as
 * the server's own object would be claiming to know something it has only been
 * told. `code` is what code branches on; `names` and `fixes` are what a person
 * reads, and this module never rewrites either (checklist B7, N3).
 */
export interface WireRefusal {
  readonly refused: true;
  readonly code: string;
  readonly names: readonly string[];
  readonly fixes: readonly string[];
}

/** The transport did not produce an answer at all. Not a refusal: an absence. */
export interface Unavailable {
  readonly unavailable: true;
  /** Why, in words, for the reader. Never a stand-in for a server's refusal. */
  readonly because: string;
}

export type CallResult<T> = { readonly ok: true; readonly value: T } | WireRefusal | Unavailable;

export function isRefusal<T>(result: CallResult<T>): result is WireRefusal {
  return 'refused' in result;
}

export function isUnavailable<T>(result: CallResult<T>): result is Unavailable {
  return 'unavailable' in result;
}

export interface ClientOptions {
  /** Where the API is. `/api` in the browser, an absolute origin in a test. */
  readonly base: string;
  /** `alpha` or `bravo`. It is a path segment, not a claim in a body. */
  readonly businessKey: string;
  /** The GoTrue access token. Absent means not signed in, which the API refuses. */
  readonly token: string | null;
  /** Injected so a test can drive the client without a network or a global. */
  readonly fetch: typeof globalThis.fetch;
  /** Injected for the same reason: a test needs a predictable operation id. */
  readonly newOperationId?: () => string;
  /**
   * The session this client was given is one the API will not vouch for.
   *
   * Called only when a token was actually sent: a 401 with no bearer is a call
   * nobody was signed in for, and ending a session that was never held would
   * be reporting an event that did not happen.
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
    return this.#post<T>(name, body);
  }

  /**
   * A mutation. `operationId` is always sent; `expectedRevision` is sent when
   * the caller has one and omitted when it does not, so that the server's
   * `EXPECTED_REVISION_REQUIRED` stays reachable from this surface rather than
   * being pre-empted by a client-side guess.
   */
  async mutate(
    name: CommandName,
    body: Readonly<Record<string, unknown>>,
    options: MutationOptions = {},
  ): Promise<CallResult<CommandOutcome>> {
    const operationId = options.operationId ?? this.newOperationId();
    const payload: Record<string, unknown> = { ...body, operationId };
    if (options.expectedRevision !== undefined) {
      payload['expectedRevision'] = options.expectedRevision;
    }
    return this.#post<CommandOutcome>(name, payload);
  }

  async #post<T>(
    name: OperationName,
    body: Readonly<Record<string, unknown>>,
  ): Promise<CallResult<T>> {
    const url = `${this.#options.base}/b/${encodeURIComponent(this.#options.businessKey)}${operationPath(name)}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // The only credential this client sends. No actor header, no business
    // header, no forwarded host: there is nothing here for a tampered request
    // to reach (checklist N7).
    if (this.#options.token !== null) headers['authorization'] = `Bearer ${this.#options.token}`;

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

    const parsed: unknown = await response.json().catch(() => undefined);

    if (isWireRefusal(parsed)) {
      if (
        response.status === 401 &&
        SESSION_ENDED.has(parsed.code) &&
        this.#options.token !== null
      ) {
        this.#options.onSessionEnded?.(parsed);
      }
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
    return { ok: true, value: parsed as T };
  }
}

/**
 * The two codes that mean the bearer is no longer a credential.
 *
 * Paired with the 401 rather than trusted alone: the code names the decision
 * and the status names the boundary that made it, and a 403 carrying either of
 * these would be a different answer than the one this rule is about.
 *
 * They are two rather than one because the API tells them apart deliberately.
 * `AUTH_UNKNOWN_LOGIN` covers every bearer the server cannot place, and saying
 * more would tell an unauthenticated caller which guess was closer.
 * `AUTH_SESSION_EXPIRED` is the exception the API documents: the signature
 * verifies against this deployment's own secret, so whoever sent it already held
 * a session here and learns nothing new from being told it ran out. The
 * difference matters to the person reading the notice and not at all to what
 * this client does about it, which is why both are on this list and neither is
 * treated as the other.
 */
const SESSION_ENDED = new Set(['AUTH_UNKNOWN_LOGIN', 'AUTH_SESSION_EXPIRED']);

function isWireRefusal(value: unknown): value is WireRefusal {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return body['refused'] === true && typeof body['code'] === 'string';
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : 'The request did not reach the API.';
