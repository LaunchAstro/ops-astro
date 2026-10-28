// SPDX-License-Identifier: AGPL-3.0-only
//
// What a `withBusiness` transaction reads: its isolation, and the `begin` text
// for it. Only these texts reach the SQL, never a caller's string (#2337).

export type Isolation = 'read committed' | 'repeatable read';

/**
 * Read committed, the default, gives each statement its own snapshot, so a
 * read after a lock sees what the lock's last holder committed (`hasRoom`).
 * Repeatable read gives the whole transaction one snapshot, taken by its first
 * statement, the business setting, before any statement of the caller's:
 * nothing committed after that is seen. It is for one-snapshot reads, and a
 * caller that opts in owes two things. A lock or write on a row changed since
 * the snapshot fails with 40001 (serialization_failure), which is the caller's
 * to retry or refuse. A read after a lock, advisory or row, still reads the
 * snapshot, not what the lock's last holder committed, so a lock-then-count
 * path such as `hasRoom` must not opt in: two callers would both see room.
 */
const BEGIN: Readonly<Record<Isolation, string>> = {
  'read committed': 'isolation level read committed',
  'repeatable read': 'isolation level repeatable read',
};

/** The `begin` text for `isolation`, refusing one this wrapper does not offer. */
export function beginFor(isolation: Isolation): string {
  if (!Object.hasOwn(BEGIN, isolation)) {
    throw new Error(
      `withBusiness: ${JSON.stringify(isolation)} is not an isolation withBusiness offers`,
    );
  }
  return BEGIN[isolation];
}
