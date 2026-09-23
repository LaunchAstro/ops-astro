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

export interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface Session {
  readonly token: string;
  /** `alpha` or `bravo`. It becomes the path prefix, never a body field. */
  readonly businessKey: string;
  readonly email: string;
}

const KEY = 'ops-astro.session';
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
 * What was interrupted: the address the person was on, and the server's word
 * for why they are being asked again.
 *
 * The code is carried rather than translated. `AUTH_UNKNOWN_LOGIN` is the one
 * the API gives for a missing, an expired and an unverifiable bearer alike, and
 * a client that rewrote it as "expired" would be claiming a distinction the
 * server refused to make.
 */
export interface Interruption {
  readonly address: string;
  readonly code: string;
}

export class SessionStore {
  readonly #storage: StorageLike | null;
  #session: Session | null = null;
  #interruption: Interruption | null = null;

  constructor(storage: StorageLike | null) {
    this.#storage = storage;
    this.#session = this.#restore();
    this.#interruption = this.#restoreInterruption();
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
    try {
      this.#storage?.setItem(RETURN_KEY, JSON.stringify(interruption));
    } catch {
      /* The tab keeps working; it lands on the board instead. */
    }
  }

  /** Read the interruption and spend it. Signing in answers it exactly once. */
  takeInterruption(): Interruption | null {
    const held = this.#interruption;
    this.#forgetInterruption();
    return held;
  }

  set(session: Session): void {
    this.#session = session;
    // A storage that throws — private mode, blocked site data — must not take
    // the sign-in with it. The session is already held in memory.
    try {
      this.#storage?.setItem(KEY, JSON.stringify(session));
    } catch {
      /* The tab keeps working; the reload will ask again. */
    }
  }

  clear(): void {
    this.#session = null;
    this.#forgetInterruption();
    try {
      this.#storage?.removeItem(KEY);
    } catch {
      /* Nothing to do: memory is already clear. */
    }
  }

  #forgetInterruption(): void {
    this.#interruption = null;
    try {
      this.#storage?.removeItem(RETURN_KEY);
    } catch {
      /* Nothing to do: memory is already clear. */
    }
  }

  #restore(): Session | null {
    let raw: string | null = null;
    try {
      raw = this.#storage?.getItem(KEY) ?? null;
    } catch {
      return null;
    }
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    return isSession(parsed) ? parsed : null;
  }

  #restoreInterruption(): Interruption | null {
    let raw: string | null = null;
    try {
      raw = this.#storage?.getItem(RETURN_KEY) ?? null;
    } catch {
      return null;
    }
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    return isInterruption(parsed) ? parsed : null;
  }
}

function isInterruption(value: unknown): value is Interruption {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  // An address is a path this application owns, never something a page could
  // be sent to from outside: a stored value naming another origin is not one
  // of ours and is dropped rather than navigated to.
  return (
    typeof body['address'] === 'string' &&
    body['address'].startsWith('/') &&
    !body['address'].startsWith('//') &&
    typeof body['code'] === 'string'
  );
}

function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body['token'] === 'string' &&
    typeof body['businessKey'] === 'string' &&
    typeof body['email'] === 'string'
  );
}
