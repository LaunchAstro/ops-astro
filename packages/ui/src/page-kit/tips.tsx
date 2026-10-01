// SPDX-License-Identifier: AGPL-3.0-only
//
// The section tip (DS-COMP-5 `section tip`, CS-9.1) and its dismissal.
//
// A dismissal belongs to the person, on every device, so it lives in their
// preferences, never in the browser. It is keyed by the page, the tip's id and
// a version of its text: rewrite a tip and the key changes, so the person sees
// the new words once. The preferences arrive through `TipPreferences`, which
// the application wires to the one preference store's save and read; this
// package imports no `core-*` package.

import { useState, type ReactElement } from 'react';
import { Banner } from '../kit/blocks.tsx';
import { IconButton } from '../kit/controls.tsx';

export interface Tip {
  /** The page's canonical address, as the route manifest names it. */
  readonly page: string;
  /** Stable for the life of the tip, whatever its words. */
  readonly id: string;
  readonly text: string;
}

export interface TipPreferences {
  /** The keys this person has dismissed, as `tipKey` makes them. */
  readonly dismissed: readonly string[];
  /** The Settings switch that hides every tip. */
  readonly tipsOff: boolean;
  readonly dismiss: (key: string) => void;
}

/** FNV-1a over the code points: stable, synchronous and the same on a server. */
function textVersion(text: string): string {
  let hash = 0x811c9dc5;
  for (const character of text) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function tipKey(tip: Tip): string {
  return `${tip.page}#${tip.id}@${textVersion(tip.text)}`;
}

export function visibleTip(tip: Tip, preferences: TipPreferences): boolean {
  return !preferences.tipsOff && !preferences.dismissed.includes(tipKey(tip));
}

export function SectionTip(props: {
  readonly tip: Tip;
  readonly preferences: TipPreferences;
}): ReactElement | null {
  // Hidden at once on the press; the saved key keeps it hidden on the next load.
  const [dismissedHere, setDismissedHere] = useState(false);
  if (dismissedHere || !visibleTip(props.tip, props.preferences)) return null;
  return (
    // The kit's info banner (DS-PRIM-22). Its own dismiss says only "Dismiss",
    // so the tip passes the kit's icon button as the banner's action instead.
    <div className="sectip">
      <Banner
        tone="info"
        action={
          <IconButton
            icon="cross-small"
            label="Dismiss this tip"
            onClick={() => {
              setDismissedHere(true);
              props.preferences.dismiss(tipKey(props.tip));
            }}
          />
        }
      >
        {props.tip.text}
      </Banner>
    </div>
  );
}
