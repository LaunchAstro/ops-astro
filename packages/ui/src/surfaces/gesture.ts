// SPDX-License-Identifier: AGPL-3.0-only
//
// The gesture law on a link, shared by every panel that opens something.

import type { MouseEvent } from 'react';

export interface OpenHow {
  /** Shift: open beside what is open, rather than in its place. */
  readonly beside: boolean;
}

/**
 * A plain press opens in place, Shift opens beside, and a press the browser
 * owns (Ctrl, Cmd, Alt, a middle button) is left to it.
 */
export function follow(event: MouseEvent<HTMLAnchorElement>, open: (how: OpenHow) => void): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey) return;
  event.preventDefault();
  open({ beside: event.shiftKey });
}

/** The in-app address a click on a link asked for, or null to leave it to the browser. */
export function inAppAddress(event: MouseEvent<HTMLElement>): string | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const anchor = (event.target as Element | null)?.closest?.('a[href]') ?? null;
  if (anchor === null) return null;
  const target = anchor.getAttribute('target');
  if ((target !== null && target !== '_self') || anchor.hasAttribute('download')) return null;
  const href = anchor.getAttribute('href') ?? '';
  return href.startsWith('/') && !href.startsWith('//') ? href : null;
}
