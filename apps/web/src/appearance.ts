// SPDX-License-Identifier: AGPL-3.0-only
//
// The person's appearance (MP-2-11, SH-60): Light, Dark or System, stored in
// the one preference store and applied at once. Applying it is setting
// `data-theme-preference` on the root, which MP-1-1's before-paint step in
// `index.html` watches and turns into `data-theme`. This tab keeps a copy in
// `sessionStorage` (never `localStorage`, the rule the session lives under), so
// that same step opens a reload in the chosen theme with no flash; signed in on
// another device, the read below applies the stored value.

import { useEffect } from 'react';
import type { OperationsClient } from './operations/client.ts';
import type { StorageLike } from './session/token.ts';

export type Appearance = 'light' | 'dark' | 'system';

/** The tab's copy, which the before-paint step in `index.html` reads by this name. */
export const APPEARANCE_KEY = 'ops-astro.appearance';

/** How long a chosen appearance crossfades; the CSS reads `data-theme-fade`. */
const FADE_MS = 500;

export function isAppearance(value: unknown): value is Appearance {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** The stored appearance in a `preference.read` answer; System when none is stored. */
export function appearanceIn(value: unknown): Appearance | null {
  if (typeof value !== 'object' || value === null) return null;
  const preferences = (value as { readonly preferences?: unknown }).preferences;
  if (typeof preferences !== 'object' || preferences === null) return null;
  const held = (preferences as Readonly<Record<string, unknown>>)['appearance'];
  return isAppearance(held) ? held : 'system';
}

/** Repaint in this appearance now, crossfading when the person chose it here. */
export function applyAppearance(
  value: Appearance,
  storage: StorageLike | null,
  fade = false,
): void {
  const root = document.documentElement;
  if (fade) {
    root.dataset['themeFade'] = '';
    window.setTimeout(() => {
      delete root.dataset['themeFade'];
    }, FADE_MS);
  }
  root.dataset['themePreference'] = value;
  try {
    storage?.setItem(APPEARANCE_KEY, value);
  } catch {
    // A tab that cannot store still repaints; only the reload replay is lost.
  }
}

/**
 * Once per signed-in session: read the person's own preferences and apply the
 * stored appearance. A refused or absent read changes nothing, and never throws.
 * Signed out, the tab's copy is dropped and the page follows the system again,
 * so one person's appearance never opens the next person's session.
 */
export function useStoredAppearance(
  client: OperationsClient,
  grantKey: string | null,
  storage: StorageLike | null,
): void {
  useEffect(() => {
    if (grantKey === null) {
      delete document.documentElement.dataset['themePreference'];
      try {
        storage?.removeItem(APPEARANCE_KEY);
      } catch {
        // Nothing kept, nothing to drop.
      }
      return;
    }
    let current = true;
    void client.read<unknown>('preference.read', {}).then((answer) => {
      const value = 'value' in answer ? appearanceIn(answer.value) : null;
      if (current && value !== null) applyAppearance(value, storage);
      return answer;
    });
    return () => {
      current = false;
    };
  }, [client, grantKey, storage]);
}
