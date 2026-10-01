// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock frame's facts the task panel's seat line reads (MP-4-8, T-D19).
//
// **What is not on this base.** The rail's collapse, more than one panel open
// at once and a dragged panel width are the dock frame's (MP-3-1). Until it
// joins, `MOCK_FRAME` reads the real viewport width and makes up the rest
// (the rail expanded, one panel, 550 asked); its placement carries the
// design system's one Mock corner label (`DockSeat.tsx`).
//
// **Wiring the real one** is one small piece: a `FrameFactsSource` whose
// `useFacts` reads the frame's rail state, open panels and asked width, with
// `provenance: 'real'`, handed to `useDockPanel`.

import { useEffect, useState } from 'react';

export interface FrameFacts {
  /** The window's inner width in pixels. */
  readonly viewport: number;
  readonly railExpanded: boolean;
  /** How many dock panels are open, this one included. */
  readonly panels: number;
  /** The width each panel asked for, in pixels. */
  readonly asked: number;
}

/** Where the frame's facts come from: `mock` is marked, `real` is not. */
export interface FrameFactsSource {
  readonly provenance: 'real' | 'mock';
  readonly useFacts: () => FrameFacts;
}

/** The default panel width (`--dock-w` seated, DS-SIDE-7). */
const DEFAULT_ASKED = 550;

function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = (): void => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

/** Made up but the width: the rail expanded, one panel open, 550 asked. */
export const MOCK_FRAME: FrameFactsSource = {
  provenance: 'mock',
  useFacts: () => ({
    viewport: useViewportWidth(),
    railExpanded: true,
    panels: 1,
    asked: DEFAULT_ASKED,
  }),
};
