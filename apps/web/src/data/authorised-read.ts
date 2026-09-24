// SPDX-License-Identifier: AGPL-3.0-only
//
// A read whose result can be trusted to be the latest one, and whose denial
// cannot be undone by an answer that was already in flight.
//
// Two rules, and they are the whole module.
//
// **A generation counter orders the answers, not the clock.** Every start mints
// the next generation. A response carrying an older generation than the one the
// projection currently holds is dropped — not merged, not shown as stale.
// Browsers reorder responses freely, and without this the common case of a
// slow first request and a fast second one ends with the screen showing the
// older of the two and no way to tell.
//
// **A denial invalidates the grant-keyed projection, and nothing older can
// restore it.** This is checklist N6: open an authorised record, revoke the
// grant, reread, and an in-flight response delayed past the denial must not put
// the authorised content back on the screen. So denial does not merely set a
// state — it raises a floor, and every response minted before that floor is
// refused entry whatever it says. The alternative, letting the newest response
// win unconditionally, is a cache that a revoked reader can repopulate by
// having been slow.
//
// The projection is keyed by grant. A different token or a different business
// is a different projection, and a read started under the old key cannot land
// in the new one — which is the same rule as the floor, expressed for the case
// where the reader changed rather than their authority.

import {
  isRefusal,
  isUnavailable,
  type CallResult,
  type WireRefusal,
} from '../operations/client.ts';

/**
 * What a read is, before anything draws it: one member per outcome.
 *
 * Every member carries `refusal` and `because`, narrowed to what that outcome
 * can hold, and every member but `loading` carries `value`. `loading` holds
 * `previous` instead, the last answer rather than this one, so a reader has to
 * narrow on `outcome` before it can draw either, and one that has gets the
 * non-null field for free.
 */
export type ReadState<T> =
  | {
      readonly outcome: 'loading';
      /**
       * The previous answer, kept on screen while the next read is in flight.
       * Null on the first read, and null after a denial or an outage, because
       * those already dropped it. Named for what it is (thermo review
       * b282216, M13): it is never this read's answer.
       */
      readonly previous: T | null;
      readonly refusal: null;
      readonly because: null;
      /** The grant this projection belongs to. A change discards it. */
      readonly grantKey: string;
    }
  | {
      /** `empty` is an authorised collection with no rows, not a failure. */
      readonly outcome: 'ready' | 'empty';
      /** The answer. Never a leftover, never a sample. */
      readonly value: T;
      readonly refusal: null;
      readonly because: null;
      readonly grantKey: string;
    }
  | {
      readonly outcome: 'denied';
      readonly value: null;
      /** The server's own refusal. Displayed verbatim by code. */
      readonly refusal: WireRefusal;
      readonly because: null;
      readonly grantKey: string;
    }
  | {
      readonly outcome: 'unavailable';
      readonly value: null;
      readonly refusal: null;
      /** Why the read did not arrive. */
      readonly because: string;
      readonly grantKey: string;
    };

export function initialState<T>(grantKey: string): ReadState<T> {
  return { outcome: 'loading', previous: null, refusal: null, because: null, grantKey };
}

/** How the caller decides whether a successful read is `ready` or `empty`. */
export type EmptinessTest<T> = (value: T) => boolean;

export interface AuthorisedReadOptions<T> {
  readonly grantKey: string;
  /** Called with every accepted state. The screen re-renders from this. */
  readonly onState: (state: ReadState<T>) => void;
  /** An authorised collection with no rows is `empty`, not `ready` and not a failure. */
  readonly isEmpty?: EmptinessTest<T>;
}

/**
 * One projection of one read, over its lifetime.
 *
 * It is a class because the floor and the generation are state that outlives a
 * single call and must not be re-created per request — a fresh counter per call
 * is no counter at all.
 */
export class AuthorisedRead<T> {
  readonly #options: AuthorisedReadOptions<T>;
  #generation = 0;
  #disposed = false;
  /** No response minted before this may be accepted. Raised by a denial. */
  #floor = 0;
  #state: ReadState<T>;

  constructor(options: AuthorisedReadOptions<T>) {
    this.#options = options;
    this.#state = initialState<T>(options.grantKey);
  }

  get state(): ReadState<T> {
    return this.#state;
  }

  /**
   * Retire this projection. Nothing it started may publish again.
   *
   * A projection outlives the read that is in flight when its holder lets it
   * go: the request is already awaiting, and when it resolves it calls
   * `accept` on an object nobody is reading from any more. If that object
   * still owns the screen's setter, a read started under the old grant can
   * land after the new grant has already been denied and put the old grant's
   * rows back on the page -- which is the same failure the floor exists to
   * prevent, arriving by the one door the floor does not watch.
   */
  dispose(): void {
    this.#disposed = true;
  }

  /** The generation a caller must hand back with the result it awaited. */
  begin(): number {
    this.#generation += 1;
    if (this.#state.outcome !== 'loading') {
      // The previous answer stays while the next one is in flight. A denial or
      // an outage has already dropped it, so from those this is null.
      this.#publish({
        outcome: 'loading',
        previous: this.#state.value,
        refusal: null,
        because: null,
        grantKey: this.#state.grantKey,
      });
    }
    return this.#generation;
  }

  /**
   * Offer a result for a generation.
   *
   * Returns whether it was accepted, so a caller and a test can both see the
   * drop rather than infer it from a screen that did not change.
   */
  accept(generation: number, result: CallResult<T>, grantKey: string): boolean {
    // Retired: its holder has moved on to another grant or another record, and
    // a result arriving now belongs to a screen that no longer exists.
    if (this.#disposed) return false;
    // Stale: something newer has already been asked for, or a denial has
    // raised the floor above this response's generation.
    if (generation <= this.#floor) return false;
    if (generation < this.#generation) return false;
    // A different grant entirely. The answer is about somebody else's
    // authority and has no home in this projection.
    if (grantKey !== this.#options.grantKey) return false;

    if (isRefusal(result)) {
      // Denial invalidates. The value goes, and the floor rises to this
      // generation so that every older in-flight response is refused entry —
      // including one that would otherwise have been "newer than what is on
      // screen" and restored the authorised content (N6).
      this.#floor = this.#generation;
      this.#publish({
        outcome: 'denied',
        value: null,
        refusal: result,
        because: null,
        grantKey: this.#options.grantKey,
      });
      return true;
    }

    if (isUnavailable(result)) {
      // Unavailable is not denial and does not invalidate: nobody decided
      // anything. The value still goes, because showing the last good answer
      // as though it were current is the substitution B7 forbids.
      this.#publish({
        outcome: 'unavailable',
        value: null,
        refusal: null,
        because: result.because,
        grantKey: this.#options.grantKey,
      });
      return true;
    }

    const empty = this.#options.isEmpty?.(result.value) ?? false;
    this.#publish({
      outcome: empty ? 'empty' : 'ready',
      value: result.value,
      refusal: null,
      because: null,
      grantKey: this.#options.grantKey,
    });
    return true;
  }

  #publish(state: ReadState<T>): void {
    this.#state = state;
    this.#options.onState(state);
  }
}
