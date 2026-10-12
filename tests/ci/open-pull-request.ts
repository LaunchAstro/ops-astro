// SPDX-License-Identifier: AGPL-3.0-only
//
// A label change on a closed or merged pull request runs nothing (OA-CILabels, 12 October 2026).
// ci.yml's contamination gate, its three `always()` aggregates and review-evidence.yml's one job
// carry this guard, and every job behind the gate skips with it. The tests that pin each job's
// condition strip the exact guard alone, then judge what is left as before, so a mangled guard is
// still a condition they refuse.

/** True on a push and a merge group; on a pull request, only while it is open. */
export const OPEN_GUARD =
  "github.event_name != 'pull_request' || github.event.pull_request.state == 'open'";

/** A condition without the exact guard: the guard alone reads as none, `always() && (guard)` as `always()`. */
export function unguarded<T>(cond: T): T | 'always()' | undefined {
  if (cond === OPEN_GUARD) return undefined;
  if (cond === `always() && (${OPEN_GUARD})`) return 'always()';
  return cond;
}

/**
 * Workflow text with each exact job-level guard line set aside, as `unguarded` reads a condition:
 * the guard's own line goes and `always() && (guard)` reads `always()`. A step's line, a command and
 * any other text keep every character.
 */
export const withoutGuardLines = (text: string): string =>
  text
    .replaceAll(`\n    if: ${OPEN_GUARD}\n`, '\n')
    .replaceAll(`\n    if: always() && (${OPEN_GUARD})\n`, '\n    if: always()\n');
