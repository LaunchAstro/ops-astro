// SPDX-License-Identifier: AGPL-3.0-only
//
// C4 (#429, CS-1.2, RA-20): the one team-only rollup read. The agency-wide
// rollups (Portfolio, Executive, Connections & signal) are reached by no topic,
// so every open page re-reads them on the 30 s floor; this read answers them
// once per viewer and reuses the answer briefly, never the per-client read in
// a loop.
//
// The cache key is the business, the viewer (person, actor and role) and a
// fingerprint of the viewer's live grants, all taken inside the call's own
// transaction after the login is resolved. So one viewer never receives
// another's rollup, and a grant narrowed, revoked or delegated inside the
// lifetime misses the cache rather than meeting a wider answer. What the
// lifetime can leave stale is the data alone, for less than the floor.

import {
  grantFingerprint,
  subjectsOf,
  withSession,
  type BusinessId,
  type Database,
  type Session,
  type TenantQuery,
  type VerifiedSubject,
} from '../../../core-records/src/index.ts';
import {
  asCallerVisible,
  isCommandRefusal,
  refuseNotFound,
  type CommandRefusal,
} from '../commands/refusal.ts';
import { isInternalReader } from './tasks.ts';

/** An agency-wide rollup: its name, and how it is worked out for one viewer. */
export interface Rollup<T extends object> {
  readonly name: string;
  compute(tx: TenantQuery, session: Session): Promise<T>;
}

export interface RollupCacheOptions {
  /** How long an answer is reused, in ms; kept below the 30 s floor. */
  readonly lifetimeMs?: number;
  /** The most answers held at once; the oldest goes first. */
  readonly capacity?: number;
  readonly now?: () => number;
}

/** One per server process; `readRollup` alone reads and fills it. */
export interface RollupCache {
  readonly size: number;
  answer(key: string, compute: () => Promise<object>): Promise<object>;
}

interface Held {
  readonly value: object;
  readonly at: number;
}

class ScopedRollupCache implements RollupCache {
  readonly #held = new Map<string, Held>();
  readonly #lifetimeMs: number;
  readonly #capacity: number;
  readonly #now: () => number;

  constructor(options: RollupCacheOptions) {
    this.#lifetimeMs = options.lifetimeMs ?? 10_000;
    this.#capacity = options.capacity ?? 1_000;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#held.size;
  }

  async answer(key: string, compute: () => Promise<object>): Promise<object> {
    const held = this.#held.get(key);
    if (held !== undefined && this.#now() - held.at < this.#lifetimeMs) return held.value;
    const value = await compute();
    this.#hold(key, { value, at: this.#now() });
    return value;
  }

  #hold(key: string, held: Held): void {
    this.#held.delete(key);
    for (const [other, { at }] of this.#held) {
      if (this.#now() - at >= this.#lifetimeMs) this.#held.delete(other);
    }
    for (const oldest of this.#held.keys()) {
      if (this.#held.size < this.#capacity) break;
      this.#held.delete(oldest);
    }
    this.#held.set(key, held);
  }
}

export function createRollupCache(options: RollupCacheOptions = {}): RollupCache {
  return new ScopedRollupCache(options);
}

/**
 * The rollup for this viewer, from the cache while their answer is fresh. A
 * login with no standing is refused at the door; a client of the business, or
 * any reader outside the team, is `NOT_FOUND` and nothing is worked out.
 */
export async function readRollup<T extends object>(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  rollup: Rollup<T>,
  cache: RollupCache,
): Promise<T | CommandRefusal> {
  const outcome = await withSession(database, businessId, presented, async (tx, session) => {
    if (!isInternalReader(session.roleKey)) return refuseNotFound();
    const key = JSON.stringify([
      session.businessId,
      session.personId,
      session.actorId,
      session.roleKey,
      rollup.name,
      await grantFingerprint(tx, subjectsOf(session)),
    ]);
    // The key names the rollup, so what is held under it is this rollup's `T`.
    return (await cache.answer(key, async () => await rollup.compute(tx, session))) as T;
  });
  return isCommandRefusal(outcome) ? asCallerVisible(outcome) : outcome;
}
