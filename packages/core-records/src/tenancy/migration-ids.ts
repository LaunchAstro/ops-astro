// SPDX-License-Identifier: AGPL-3.0-only
//
// Migration IDs. A migration is `migrations/<id>_<name>.sql`; its version, the
// file name without `.sql`, is what the ledger records and the runner sorts.
//
// An ID takes one of two forms, and every one of the first sorts before every
// one of the second, since one starts with 0 and the other with 2:
//
// - Four digits, 0001 upward with no gap: every migration written before the
//   move to timestamps. An applied migration is never renamed, so these stay.
// - A UTC timestamp, YYYYMMDDHHMMSS: every migration written since (Code
//   Factory METHOD, Phase 2 step 7). Lanes writing migrations at once pick
//   different IDs without asking each other, and a fixed width makes the
//   string order the time order.
//
// The runner holds shape and uniqueness on every directory it reads. The check
// before approval and in the queue (scripts/migration-ids.mjs) adds what needs
// the base branch or a clock: a new migration sorts after the base's newest,
// the four-digit range has no gap, and no timestamp is ahead of the clock.

// A timestamp starts 20: a year before 2000 would sort before a four-digit ID.
const VERSION = /^(?<id>\d{4}|20\d{12})_[a-z0-9]+(?:_[a-z0-9]+)*$/u;

/** A timestamp more than this far ahead of the clock is refused: UTC, not local time. */
const CLOCK_SKEW_MS = 3_600_000;

/** The ID of a well-formed version, or undefined. */
export function migrationId(version: string): string | undefined {
  return VERSION.exec(version)?.groups?.['id'];
}

/** A fourteen-digit ID as the instant it names, or undefined when it names none. */
function instantOf(id: string): number | undefined {
  const [year, month, day, hour, minute, second] = [0, 4, 6, 8, 10, 12].map((at, i) =>
    Number(id.slice(at, i === 0 ? 4 : at + 2)),
  ) as [number, number, number, number, number, number];
  const instant = Date.UTC(year, month - 1, day, hour, minute, second);
  // Date.UTC rolls 30 February into March; reading the ID back refuses it.
  const back = new Date(instant).toISOString().replaceAll(/[-:T]/gu, '').slice(0, 14);
  return back === id ? instant : undefined;
}

/** What is wrong with a set of versions on its own: shape, a real instant, and each ID once. */
export function migrationIdProblems(versions: readonly string[]): readonly string[] {
  const problems: string[] = [];
  const byId = new Map<string, string>();
  for (const version of versions.toSorted()) {
    const id = migrationId(version);
    if (id === undefined || (id.length === 14 && instantOf(id) === undefined)) {
      problems.push(
        `${version} is not a migration name: <id>_<name>.sql, the ID four digits or a UTC ` +
          `timestamp YYYYMMDDHHMMSS from 2000 on, the name lower case, digits and underscores`,
      );
      continue;
    }
    const first = byId.get(id);
    if (first === undefined) byId.set(id, version);
    else problems.push(`${first} and ${version} have the same ID, ${id}`);
  }
  return problems;
}

/**
 * What is wrong with `head` as a change to `base`, beyond `migrationIdProblems`:
 * a migration it adds that sorts before the base's newest, a gap in the
 * four-digit range, and a timestamp ahead of `now`.
 */
export function migrationPlacementProblems(
  base: readonly string[],
  head: readonly string[],
  now: number,
): readonly string[] {
  const problems: string[] = [];
  const numbered = head.toSorted().filter((version) => migrationId(version)?.length === 4);
  const gap = numbered.findIndex((v, i) => migrationId(v) !== String(i + 1).padStart(4, '0'));
  if (gap !== -1) {
    problems.push(
      `${String(numbered[gap])}: the four-digit IDs run from 0001 with no gap, so this one ` +
        `would be ${String(gap + 1).padStart(4, '0')}; a new migration takes a UTC timestamp ID`,
    );
  }
  const known = new Set(base);
  const newest = base.toSorted().at(-1);
  for (const version of head.toSorted().filter((v) => !known.has(v))) {
    if (newest !== undefined && version <= newest) {
      problems.push(
        `${version} sorts before ${newest}, the base branch's newest migration: give it a new ` +
          `UTC timestamp ID, since an installation at ${newest} would apply it out of order`,
      );
    }
    const id = migrationId(version);
    const instant = id?.length === 14 ? instantOf(id) : undefined;
    if (instant !== undefined && instant > now + CLOCK_SKEW_MS) {
      problems.push(
        `${version} is ahead of the clock: IDs are UTC, so local time read as UTC sorts ` +
          `after migrations written later`,
      );
    }
  }
  return problems;
}
