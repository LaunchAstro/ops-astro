// SPDX-License-Identifier: AGPL-3.0-only
//
// Guided tips in the one preference store (MP-2-11, CS-9.1). Stub: the
// shapes and the helpers land with the store's dismiss.

/** One tip as a page draws it: where, which, and the version of its text. */
export interface TipRef {
  readonly page: string;
  readonly tip: string;
  readonly version: number;
}

export function tipKey(page: string, tip: string): string {
  return `${page}#${tip}`;
}

export function tipShown(_preferences: Readonly<Record<string, unknown>>, _ref: TipRef): boolean {
  return true;
}

export function dismissedTipCount(_preferences: Readonly<Record<string, unknown>>): number {
  return 0;
}
