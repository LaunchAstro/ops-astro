// SPDX-License-Identifier: AGPL-3.0-only
// Red-first stub for S0-1c: the signatures only.

export const BUILD_SELECTOR = '[data-build]';

export interface ServedBuildVerdict {
  readonly ok: boolean;
  readonly line: string;
}

export function stampInDocument(_html: string): string | undefined {
  return undefined;
}

export function servedBuildVerdict(_given: {
  readonly label: string;
  readonly shown: string | null | undefined;
  readonly entry: string | undefined;
  readonly expected: string | undefined;
}): ServedBuildVerdict {
  return { ok: false, line: 'not built yet (S0-1c)' };
}
