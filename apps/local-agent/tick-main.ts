// SPDX-License-Identifier: AGPL-3.0-only
// LA-1 (#859): the long-lived local tick process (stub; red).
export function tickSettings(_env: Readonly<Record<string, string | undefined>>): {
  readonly ok: boolean;
  readonly code?: string;
} {
  return { ok: false, code: 'NOT_BUILT' };
}
