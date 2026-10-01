// SPDX-License-Identifier: AGPL-3.0-only
//
// Guided tips in the one preference store (MP-2-11, CS-9.1). A dismissal is
// kept in the person's `tips.dismissed`, one entry per page and tip holding
// the version of the text dismissed, so a rewritten tip (a higher version) is
// shown again (SH-27). `tips.enabled` false hides every tip. The server and
// the page kit (MP-9-1) share these shapes and the one reading of the store.

/** One tip as a page draws it: where, which, and the version of its text. */
export interface TipRef {
  readonly page: string;
  readonly tip: string;
  readonly version: number;
}

/** A route id such as `agency:projects-board`: lower-case words, `-` and `:`. */
export const TIP_PAGE_SHAPE: RegExp = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*$/u;
/** A tip's id on its page: lower-case words and `-`. */
export const TIP_ID_SHAPE: RegExp = /^[a-z][a-z0-9-]*$/u;
export const TIP_PART_LENGTH = 64;
export const TIP_VERSION_MAX = 1_000_000;
/** The most tips one person's store holds; far above what the pages draw. */
export const TIPS_HELD_MAX = 500;

/** Whether a dismissal names a page, a tip and a text version in shape. */
export function isTipRef(ref: {
  readonly page: unknown;
  readonly tip: unknown;
  readonly version: unknown;
}): ref is TipRef {
  const { page, tip, version } = ref;
  return (
    typeof page === 'string' &&
    page.length <= TIP_PART_LENGTH &&
    TIP_PAGE_SHAPE.test(page) &&
    typeof tip === 'string' &&
    tip.length <= TIP_PART_LENGTH &&
    TIP_ID_SHAPE.test(tip) &&
    Number.isInteger(version) &&
    (version as number) >= 1 &&
    (version as number) <= TIP_VERSION_MAX
  );
}

/** The entry's name in `tips.dismissed`. `#` is in neither shape, so it cannot collide. */
export function tipKey(page: string, tip: string): string {
  return `${page}#${tip}`;
}

const dismissedOf = (preferences: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const held = preferences['tips.dismissed'];
  return typeof held === 'object' && held !== null ? (held as Record<string, unknown>) : {};
};

/** Whether the page draws this tip for the person whose preferences these are. */
export function tipShown(preferences: Readonly<Record<string, unknown>>, ref: TipRef): boolean {
  if (preferences['tips.enabled'] === false) return false;
  return dismissedOf(preferences)[tipKey(ref.page, ref.tip)] !== ref.version;
}

/** How many tips a reset would bring back: the Settings row derives it here. */
export function dismissedTipCount(preferences: Readonly<Record<string, unknown>>): number {
  return Object.keys(dismissedOf(preferences)).length;
}
