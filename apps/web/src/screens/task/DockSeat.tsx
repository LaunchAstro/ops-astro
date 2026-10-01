// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel's place (MP-4-8, T-D19): seated at the edge, floating
// over the page, the sheet or the bottom sheet, as `seatFor` rules from the
// frame's facts. A seated or floating panel takes the ruled width; a sheet
// takes the full width. The styles are `6-slice.css`.
//
// A made-up frame (`MOCK_FRAME`) marks the placement with the design system's
// one Mock corner label (`SourceRegion`); a real one never carries it. The
// shell's third track, which narrows the page beside a seated panel, stays the
// dock frame's (MP-3-1).

import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { SourceRegion } from '@launchastro/ui';
import type { FrameFactsSource } from './frame-seam.ts';
import { seatFor, type Seat } from './seat-line.ts';

/** The seat the frame's facts give; a hook, as the facts may be. */
export function useSeat(source: FrameFactsSource): Seat {
  return seatFor(source.useFacts());
}

export function DockSeat(props: {
  readonly source: FrameFactsSource;
  readonly children: ReactNode;
}): ReactElement | null {
  const seat = useSeat(props.source);
  if (props.children === null || props.children === undefined) return null;
  const sheet = seat.placement === 'sheet' || seat.placement === 'bottom-sheet';
  const style: CSSProperties | undefined = sheet ? undefined : { width: `${seat.width}px` };
  return (
    <div className="dtp-seat" data-placement={seat.placement} style={style}>
      <SourceRegion provenance={props.source.provenance}>{props.children}</SourceRegion>
    </div>
  );
}
