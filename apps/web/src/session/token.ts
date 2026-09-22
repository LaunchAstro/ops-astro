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

export class SessionStore {
  readonly #storage: StorageLike | null;
  #session: Session | null = null;

  constructor(storage: StorageLike | null) {
    this.#storage = storage;
    this.#session = this.#restore();
  }

  get session(): Session | null {
    return this.#session;
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
    try {
      this.#storage?.removeItem(KEY);
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
