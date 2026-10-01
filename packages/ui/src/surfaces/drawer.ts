// SPDX-License-Identifier: AGPL-3.0-only
//
// The narrow drawer's focus (MP-2-8), which the shell owns while the
// application owns whether the drawer is open.

import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Wires the drawer (`railRef`) and its toggle; returns the Tab trap for the
 * drawer's own key handler.
 */
export function useDrawerFocus(
  open: boolean,
  onToggle: ((open: boolean) => void) | undefined,
  railRef: RefObject<HTMLElement | null>,
  toggleRef: RefObject<HTMLButtonElement | null>,
): (event: KeyboardEvent<HTMLElement>) => void {
  // Focus moves into the drawer on open and back to its toggle on close.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) {
      const rail = railRef.current;
      const into =
        rail?.querySelector<HTMLElement>('[data-lit]') ??
        rail?.querySelector<HTMLElement>(FOCUSABLE);
      into?.focus();
    }
    if (!open && wasOpen.current) toggleRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  // One Escape closes the drawer and nothing under it.
  useEffect(() => {
    if (!open || onToggle === undefined) return;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onToggle(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onToggle]);

  return (event) => {
    if (open) keepTabInside(event, railRef.current);
  };
}

/** While the drawer is open, Tab and Shift+Tab stay inside it. */
function keepTabInside(event: KeyboardEvent<HTMLElement>, rail: HTMLElement | null): void {
  if (event.key !== 'Tab') return;
  const inside = [...(rail?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
  const first = inside[0];
  const last = inside.at(-1);
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
