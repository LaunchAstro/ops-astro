// SPDX-License-Identifier: AGPL-3.0-only
//
// The signed-in session: a business, an email, and where they are kept.
//
// **No token**: the credential is the `HttpOnly` cookie the API set (S0-6c).
// What the page shows and routes by is kept in `sessionStorage`, never
// `localStorage`, so a reload keeps the person signed in (checklist B5).
//
// The storage is an interface rather than the global. That is what lets a test
// drive the whole session without a browser, and it means this module is a
// plain `.ts` file with no DOM in it.
//
// **Where a person was when the session ended is kept here too.** The token
// lasts an hour, and the API refuses one it will not act on with either
// `AUTH_SESSION_EXPIRED` (it verifies and its `exp` has passed) or
// `AUTH_UNKNOWN_LOGIN` (anything else). Either way the handling is to end the
// session and ask again — and asking again is only usable if the address
// survives it. It is the same store
// because it has the same lifetime and the same rule: `sessionStorage`, never
// `localStorage`, gone when the tab is.

// Storage access moved whole to storage-slot.ts to keep this file under the
// line limit; it is re-exported so every importer reads it from here as before.
import { isRecord, jsonSlot, type JsonSlot, type StorageLike } from './storage-slot.ts';

export { isRecord, jsonSlot, tabStorage } from './storage-slot.ts';
export type { JsonSlot, StorageLike } from './storage-slot.ts';

export interface Session {
  /** `alpha` or `bravo`. It becomes the path prefix, never a body field. */
  readonly businessKey: string;
  readonly email: string;
  /** The id the API gave this tab's sign-in, sent on every call; absent, refused. */
  readonly sessionId?: string;
}

const KEY = 'ops-astro.session';

/**
 * Where `/settings` keeps the last write this session had confirmed, per
 * business. It is named here because sign-out removes it: the tab outlives the
 * session, and the next person to sign in to it must not inherit the value.
 */
export const settingsCacheKey = (businessKey: string): string =>
  `ops-astro.settings.${businessKey}`;

/** Where the dock keeps its open set, per business. A switch or sign-out removes it. */
export const dockKey = (businessKey: string): string => `ops-astro.dock.${businessKey}`;

/** The tab's copy of the person's rail and dock sizes, per business. A switch or sign-out removes it. */
export const layoutKey = (businessKey: string): string => `ops-astro.layout.${businessKey}`;

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

/**
 * How many times this tab's owner has changed: a session ended, or a sign-in
 * to another business or as another person replaced the one held. An answer
 * tagged under an earlier owner is that owner's alone (`data/owned.ts`).
 */
let owners = 0;
export const tabOwnerGeneration = (): number => owners;

/** Where to go back to once the person has signed in again. */
const RETURN_KEY = 'ops-astro.return-to';

/** Every business this sign-in has held in the tab, so sign-out reaches each one's copies. */
const HELD_KEY = 'ops-astro.held-businesses';

/**
 * A business key as this tab names one in storage: lower-case letters, digits,
 * `_` and `-`, starting with a letter or digit. The list is the tab's, not this
 * code's, so each entry is read on its own and any other is skipped, never
 * the whole list (the business a sign-in ends in is cleared whatever it holds).
 */
const BUSINESS_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

const businessesIn = (value: unknown[]): string[] =>
  value.filter((each): each is string => typeof each === 'string' && BUSINESS_KEY.test(each));

/** What the tab keeps for one business: its confirmed settings, dock and layout copies. */
function forgetBusiness(storage: StorageLike | null, businessKey: string): void {
  for (const key of [settingsCacheKey, dockKey, layoutKey]) {
    jsonSlot(storage, key(businessKey), isRecord).remove();
  }
}

/**
 * The grant key the read projections are keyed on.
 *
 * Business, person and session generation: a projection survives no change
 * of reader, tenancy or session.
 */
export function grantKeyOf(session: Session | null): string {
  return session === null
    ? 'anonymous'
    : `${session.businessKey}:${session.email}:${String(endings)}`;
}

/**
 * What was interrupted: the address the person was on, the business that
 * address meant, and the server's word for why they are being asked again.
 *
 * The code is carried rather than translated. The API answers
 * `AUTH_SESSION_EXPIRED` for a bearer whose signature verifies and whose `exp`
 * has passed, and `AUTH_UNKNOWN_LOGIN` for a missing, forged, unsigned or
 * subject-less one (`docs/local/WEB.md`). The server's own word is the one
 * kept, so a client never claims more, or less, than the server said.
 *
 * **The business is part of the address, even though it is not in it.** A task
 * address is `/task/<key>` and the key is business-local: the business is what
 * the client puts in the path prefix. So `/task/T-12` names one record in
 * Bravo and a different one in Alpha, and an address remembered without its
 * business is a string that may resolve to somebody else's task. It is kept
 * here because it is not a credential -- it is the word in the URL prefix and
 * the word printed in the top bar.
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
  readonly #held: JsonSlot<unknown[]>;
  #session: Session | null = null;
  #interruption: Interruption | null = null;

  constructor(storage: StorageLike | null) {
    this.#storage = storage;
    this.#kept = jsonSlot(storage, KEY, isSession);
    this.#returnTo = jsonSlot(storage, RETURN_KEY, isInterruption);
    this.#held = jsonSlot(storage, HELD_KEY, Array.isArray);
    // A session kept before the cookie (S0-6c) also held its bearer: only the
    // fields a session has now are taken, and written back over the old copy.
    const kept = this.#kept.read();
    this.#session = kept === null ? null : cookieEra(kept);
    if (this.#session !== null) this.#kept.write(this.#session);
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
    const leaving = this.#session;
    // A switch keeps the sign-in: what the tab holds for the business it
    // leaves goes now, settings included (#888), and the business is listed
    // so a sign-out after a reload still reaches an answer that lands late.
    if (leaving !== null && leaving.businessKey !== session.businessKey) {
      forgetBusiness(this.#storage, leaving.businessKey);
    }
    if (leaving?.businessKey !== session.businessKey || leaving.email !== session.email) {
      owners += 1;
    }
    const held = businessesIn(this.#held.read() ?? []);
    if (!held.includes(session.businessKey)) this.#held.write([...held, session.businessKey]);
    this.#session = session;
    this.#kept.write(session);
  }

  clear(): void {
    const ending = this.#session;
    endings += 1;
    owners += 1;
    this.#session = null;
    this.#forgetInterruption();
    this.#kept.remove();
    const held = new Set(businessesIn(this.#held.read() ?? []));
    if (ending !== null) held.add(ending.businessKey);
    for (const businessKey of held) forgetBusiness(this.#storage, businessKey);
    this.#held.remove();
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
    typeof body['businessKey'] === 'string' &&
    typeof body['email'] === 'string' &&
    (body['sessionId'] === undefined || typeof body['sessionId'] === 'string')
  );
}

/** A kept session with nothing but the fields a session has. */
function cookieEra({ businessKey, email, sessionId }: Session): Session {
  return sessionId === undefined ? { businessKey, email } : { businessKey, email, sessionId };
}
