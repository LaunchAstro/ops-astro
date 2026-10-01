// SPDX-License-Identifier: AGPL-3.0-only
//
// The wide rail's own parts (MP-2-3), drawn by the shell: the fold, one
// section's link, and the grip on its right edge. The narrow drawer (MP-2-8)
// draws neither the fold nor the grip.

import type { ReactElement } from 'react';
import { Icon, type GlyphName } from '../primitives/Icon.tsx';
import { EdgeGrip } from './EdgeGrip.tsx';

export interface RailEntry {
  /** Namespace-qualified. Sixteen bare identifiers collide in the corpus. */
  readonly id: string;
  readonly label: string;
  readonly href: string;
  /** The section the page being drawn sits in (MP-2-2). */
  readonly lit?: boolean;
  /** The lit section's own address is the page being drawn. */
  readonly exact?: boolean;
  /** "Back to Clients": a link in the small primary dress above the sections (MP-2-9). */
  readonly kind?: 'section' | 'back';
  /** The section's own glyph, drawn only once the rail folds (MP-2-2, T-R4). */
  readonly icon?: GlyphName | undefined;
}

/** The rail's width at rest, its grip's range, and the folded strip (SIDEBAR DS-SIDE-11). */
export const RAIL_DEFAULT = 224;
export const RAIL_MIN = 170;
export const RAIL_MAX = 400;
export const RAIL_STRIP = 56;

/**
 * First in the rail, where it is drawn, and it says whether the rail is open
 * (the mockup appended it last and said neither).
 */
export function RailFold(props: {
  readonly collapsed: boolean;
  readonly onFold: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      className="railfold"
      aria-label={props.collapsed ? 'Expand the menu' : 'Collapse the menu'}
      aria-expanded={!props.collapsed}
      onClick={props.onFold}
    >
      <Icon name={props.collapsed ? 'angle-double-right' : 'angle-double-left'} />
    </button>
  );
}

export function RailItem(props: {
  readonly entry: RailEntry;
  readonly collapsed: boolean;
}): ReactElement {
  const { entry } = props;
  return (
    <a
      className="rail__item"
      href={entry.href}
      // The current section is lit on every address, a task or a booking page
      // included: `page` where the section's own address is open, `location`
      // where one of its pages is.
      {...(entry.lit === true
        ? {
            'data-lit': '',
            'aria-current': entry.exact === true ? ('page' as const) : ('location' as const),
          }
        : {})}
      // In the strip the name shows on hover; the label stays the item's
      // accessible name, hidden only from sight.
      {...(props.collapsed ? { title: entry.label } : {})}
    >
      {/* The section's glyph, drawn once the rail folds (MP-2-2); a section
          with none keeps its initial. */}
      {entry.icon === undefined ? (
        <span className="rail__glyph" aria-hidden="true">
          {entry.label.slice(0, 1)}
        </span>
      ) : (
        <span className="rail__icon" data-glyph={entry.icon} aria-hidden="true">
          <Icon name={entry.icon} size="sm" />
        </span>
      )}
      <span className="rail__label">{entry.label}</span>
    </a>
  );
}

export function RailGrip(props: {
  readonly width: number;
  readonly onDragging: (dragging: boolean) => void;
  readonly onResize: (width: number) => void;
  readonly onResizeEnd?: ((width: number) => void) | undefined;
}): ReactElement {
  return (
    <EdgeGrip
      edge="right"
      className="railgrip"
      label="Menu width"
      value={props.width}
      min={RAIL_MIN}
      max={RAIL_MAX}
      reset={RAIL_DEFAULT}
      per={1}
      onDragging={props.onDragging}
      onChange={props.onResize}
      onCommit={props.onResizeEnd}
    />
  );
}
