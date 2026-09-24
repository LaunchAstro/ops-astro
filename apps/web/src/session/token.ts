// SPDX-License-Identifier: AGPL-3.0-only
//
// The signed-in session: a token, a business, and where they are kept.
//
// **In memory first, session storage second, and never local storage.** The
// token is the whole credential, so it lives for as long as the tab does and no
// longer: `sessionStorage` is cleared when the tab closes, and that is the
// behaviour wanted. A reload must not sign the person out — checklist B5 asks
// for a hard reload of the task address — and a closed tab must not leave a
// bearer token behind on a shared machine.
//
// The storage is an interface rather than the global. That is what lets a test
// drive the whole session without a browser, and it means this module is a
// plain `.ts` file with no DOM in it.
//
// **Where a person was when the session ended is kept here too.** The token
// lasts an hour and the API cannot tell an expired one from an unverifiable
// one, so the only honest handling is to end the session and ask again — and
// asking again is only usable if the address survives it. It is the same store
// because it has the same lifetime and the same rule: `sessionStorage`, never
// `localStorage`, gone when the tab is.

/** The narrow part of `Storage` the session and `/settings` use. */
export interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

/** One JSON value kept under one key. */
export interface JsonSlot<T> {
  /** The value, or null when there is none, it is not JSON or the guard rejects it. */
  readonly read: () => T | null;
  readonly write: (value: T) => void;
  readonly remove: () => void;
}

/**
 * The one place browser storage is read and written as JSON.
 *
 * A storage that throws — private mode, blocked site data — must not take the
 * tab with it: every call is caught, a failed read is "nothing kept", and a
 * failed write or removal leaves memory as the only copy, which it already is.
 * A stored value is read through `guard`, because the storage belongs to the
 * tab and not to this code.
 */
export function jsonSlot<T>(
  storage: StorageLike | null,
  key: string,
  guard: (value: unknown) => value is T,
): JsonSlot<T> {
  return {
    read: () => {
      try {
        const raw = storage?.getItem(key) ?? null;
        if (raw === null) return null;
        const parsed: unknown = JSON.parse(raw);
        return guard(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    write: (value) => {
      try {
        storage?.setItem(key, JSON.stringify(value));
      } catch {
        /* The tab keeps working on what it holds in memory. */
      }
    },
    remove: () => {
      try {
        storage?.removeItem(key);
      } catch {
        /* Nothing to do: memory is already clear. */
      }
    },
  };
}

/**
 * This tab's `sessionStorage`, or null where there is none or it is blocked.
 * Blocked site data makes the global throw on access, not only on use.
 */
export function tabStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Any JSON object. What a slot guard starts from. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export interface Session {
  readonly token: string;
  /** `alpha` or `bravo`. It becomes the path prefix, never a body field. */
  readonly businessKey: string;
  readonly email: string;
}

const KEY = 'ops-astro.session';

/**
 * Where `/settings` keeps the last write this session had confirmed, per
 * business. It is named here because sign-out removes it: the tab outlives the
 * session, and the next person to sign in to it must not inherit the value.
 */
export const settingsCacheKey = (businessKey: string): string =>
  `ops-astro.settings.${businessKey}`;

/**
 * How many times a session has ended in this tab: the session generation.
 *
 * A request can be answered after the session that sent it has gone. What it
 * would leave in the tab must then be left out, or it outlives the sign-out
 * that removed it. A caller notes the generation before the request and writes
 * only if it has not moved. It is the tab's, not one store's, because the tab
 * is what the leftover would outlive.
 */
let endings = 0;
export const sessionGeneration = (): number => endings;

/** Where to go back to once the person has signed in again. */
const RETURN_KEY = 'ops-astro.return-to';

/**
 * The grant key the read projections are keyed on.
 *
 * Token and business together: a different token is a different reader and a
 * different business is a different tenancy, and a projection may survive
 * neither change.
 */
export function grantKeyOf(session: Session | null): string {
  return session === null ? 'anonymous' : `${session.businessKey}:${session.token}`;
}

/**
 * What was interrupted: the address the person was on, the business that
 * address meant, and the server's word for why they are being asked again.
 *
 * The code is carried rather than translated. `AUTH_UNKNOWN_LOGIN` is the one
 * the API gives for a missing, an expired and an unverifiable bearer alike, and
 * a client that rewrote it as "expired" would be claiming a distinction the
 * server refused to make.
 *
 * **The business is part of the address, even though it is not in it.** A task
 * address is `/task/<key>` and the key is business-local: the business is what
 * the client puts in the path prefix. So `/task/T-12` names one record in
 * Bravo and a different one in Alpha, and an address remembered without its
 * business is a string that may resolve to somebody else's task. It is kept
 * here because it is not a credential -- it is the word in the URL prefix and
 * the word printed in the top bar -- and the token is emphatically not kept.
 */
export interface Interruption {
  readonly address: string;
  readonly businessKey: string;
  readonly code: string;
}

export class SessionStore {
  readonly #storage: StorageLike | null;
  readonly #kept: JsonSlot<Session>;
  readonly #returnTo: JsonSlot<Interruption>;
  #session: Session | null = null;
  #interruption: Interruption | null = null;

  constructor(storage: StorageLike | null) {
    this.#storage = storage;
    this.#kept = jsonSlot(storage, KEY, isSession);
    this.#returnTo = jsonSlot(storage, RETURN_KEY, isInterruption);
    this.#session = this.#kept.read();
    this.#interruption = this.#returnTo.read();
  }

  get session(): Session | null {
    return this.#session;
  }

  /** The interruption still waiting to be answered, if there is one. */
  get interruption(): Interruption | null {
    return this.#interruption;
  }

  /**
   * The session has ended: drop it, and remember where the person was.
   *
   * Only the first call of a burst records anything. Two reads in flight are
   * refused separately and both report it, and the second must not overwrite
   * the remembered address with the sign-in screen it is already on.
   */
  end(interruption: Interruption): void {
    if (this.#session === null) return;
    this.clear();
    this.#interruption = interruption;
    // A storage that refuses leaves the tab working; it lands on the board.
    this.#returnTo.write(interruption);
  }

  /** Read the interruption and spend it. Signing in answers it exactly once. */
  takeInterruption(): Interruption | null {
    const held = this.#interruption;
    this.#forgetInterruption();
    return held;
  }

  set(session: Session): void {
    // Held in memory first, so a storage that refuses cannot take the sign-in
    // with it; the reload will ask again.
    this.#session = session;
    this.#kept.write(session);
  }

  clear(): void {
    const ending = this.#session;
    endings += 1;
    this.#session = null;
    this.#forgetInterruption();
    this.#kept.remove();
    if (ending !== null) {
      jsonSlot(this.#storage, settingsCacheKey(ending.businessKey), isRecord).remove();
    }
  }

  #forgetInterruption(): void {
    this.#interruption = null;
    this.#returnTo.remove();
  }
}

function isInterruption(value: unknown): value is Interruption {
  if (!isRecord(value)) return false;
  const body = value;
  // An address is a path this application owns, never something a page could
  // be sent to from outside: a stored value naming another origin is not one
  // of ours and is dropped rather than navigated to.
  return (
    typeof body['address'] === 'string' &&
    body['address'].startsWith('/') &&
    !body['address'].startsWith('//') &&
    typeof body['businessKey'] === 'string' &&
    typeof body['code'] === 'string'
  );
}

function isSession(value: unknown): value is Session {
  if (!isRecord(value)) return false;
  const body = value;
  return (
    typeof body['token'] === 'string' &&
    typeof body['businessKey'] === 'string' &&
    typeof body['email'] === 'string'
  );
}
