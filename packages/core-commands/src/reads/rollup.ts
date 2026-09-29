// SPDX-License-Identifier: AGPL-3.0-only
//
// C4 (#429, CS-1.2, RA-20): the one team-only rollup read. Stub for the red run.

import { withSession } from '../../../core-records/src/index.ts';
import type {
  BusinessId,
  Database,
  Session,
  TenantQuery,
  VerifiedSubject,
} from '../../../core-records/src/index.ts';
import { asCallerVisible, isCommandRefusal, type CommandRefusal } from '../commands/refusal.ts';

/** An agency-wide rollup: what it is called, and how it is worked out for one viewer. */
export interface Rollup<T extends object> {
  readonly name: string;
  compute(tx: TenantQuery, session: Session): Promise<T>;
}

export interface RollupCacheOptions {
  /** How long an answer is reused; below the 30 s floor. */
  readonly lifetimeMs?: number;
  /** The most answers held at once. */
  readonly capacity?: number;
  readonly now?: () => number;
}

export interface RollupCache {
  readonly size: number;
}

class NameKeyedCache implements RollupCache {
  readonly entries = new Map<string, unknown>();
  get size(): number {
    return this.entries.size;
  }
}

export function createRollupCache(_options: RollupCacheOptions = {}): RollupCache {
  return new NameKeyedCache();
}

export async function readRollup<T extends object>(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  rollup: Rollup<T>,
  cache: RollupCache,
): Promise<T | CommandRefusal> {
  const entries = (cache as NameKeyedCache).entries;
  const outcome = await withSession(database, businessId, presented, async (tx, session) => {
    if (entries.has(rollup.name)) return entries.get(rollup.name) as T;
    const value = await rollup.compute(tx, session);
    entries.set(rollup.name, value);
    return value;
  });
  return isCommandRefusal(outcome) ? asCallerVisible(outcome) : (outcome as T);
}
