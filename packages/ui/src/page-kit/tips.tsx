// SPDX-License-Identifier: AGPL-3.0-only
//
// The section tip (DS-COMP-5 `section tip`, CS-9.1) and its dismissal.
//
// A dismissal belongs to the person, on every device, so it lives in their
// preferences, never in the browser. It is kept as the one store keeps it
// (`preference.dismiss_tip`, core-wire's `tips.ts`): the entry `page#tip`
// holds the version dismissed. Rewrite a tip and raise its version, and the
// person sees the new words once. The preferences arrive through
// `TipPreferences`, which the application wires to that command and the
// preference read; this package imports no `core-*` package.

import { useState, type ReactElement } from 'react';
import { Banner } from '../kit/blocks.tsx';
import { IconButton } from '../kit/controls.tsx';

export interface Tip {
  /** The page's canonical address, as the route manifest names it. */
  readonly page: string;
  /** Stable for the life of the tip, whatever its words. */
  readonly id: string;
  /** A whole number from 1, raised whenever the words change. */
  readonly version: number;
  readonly text: string;
}

export interface TipPreferences {
  /** The store's `tips.dismissed`: each `tipKey` and the version dismissed. */
  readonly dismissed: Readonly<Record<string, number>>;
  /** The Settings switch that hides every tip. */
  readonly tipsOff: boolean;
  readonly dismiss: (key: string, version: number) => void;
}

/** The entry's name in `tips.dismissed`, as core-wire's `tipKey` makes it. */
export function tipKey(tip: Pick<Tip, 'page' | 'id'>): string {
  return `${tip.page}#${tip.id}`;
}

export function visibleTip(tip: Tip, preferences: TipPreferences): boolean {
  return !preferences.tipsOff && preferences.dismissed[tipKey(tip)] !== tip.version;
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
              props.preferences.dismiss(tipKey(props.tip), props.tip.version);
            }}
          />
        }
      >
        {props.tip.text}
      </Banner>
    </div>
  );
}
