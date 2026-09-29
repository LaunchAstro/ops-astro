// SPDX-License-Identifier: AGPL-3.0-only
//
// S6: the shell around all of them. Not a route.
//
// Three tracks on the agency face above 900 pixels — rail, content, dock — and
// one below it, where the rail becomes a drawer and the dock's tab strip
// rotates onto the bottom edge. The third track's width is a variable the shell
// writes and nothing else does.
//
// The rail folds to a 56px strip of glyphs, each with its section's name on
// hover, and its right edge drags it from 170 to 400 (MP-2-3). The person's
// choice is the application's to hold and to keep; what the shell draws on
// its first render is what it is handed, so nothing jumps before paint.
//
// This component holds no session state. Panel open state, the drawer and the
// current face belong to `apps/web`, because `packages/ui` owns visual controls
// and layout and may not own a session [ui-reference CONTRACT.md:305 rule 3].

import {
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Dock, useReadyAfterFirstLayout, type DockProps } from './Dock.tsx';
import { EdgeGrip } from './EdgeGrip.tsx';

/** The rail's width at rest, its grip's range, and the folded strip (SIDEBAR DS-SIDE-11). */
export const RAIL_DEFAULT = 224;
export const RAIL_MIN = 170;
export const RAIL_MAX = 400;
export const RAIL_STRIP = 56;

export interface RailEntry {
  /** Namespace-qualified. Sixteen bare identifiers collide in the corpus. */
  readonly id: string;
  readonly label: string;
  readonly href: string;
}

export interface ShellProps {
  readonly face: 'agency' | 'client';
  readonly rail: readonly RailEntry[];
  /** The address of the page being drawn, so the rail can mark it. */
  readonly here: string;
  readonly title: string;
  readonly meta?: ReactNode;
  /** The dock, or null where there is none: signed out, and on the client face (R17). */
  readonly dock: DockProps | null;
  /** The dock's grid track: the seated group's width, or 0 while it floats. */
  readonly dockWidth?: number;
  /** The one sheet height below the side tier, so the page can be padded under it. */
  readonly dockSheetHeight?: number;
  /** The person's rail: folded to the 56px strip, and its width while open. */
  readonly railCollapsed?: boolean;
  readonly railWidth?: number;
  readonly onRailFold?: () => void;
  /** The rail's width while its grip moves. */
  readonly onRailResize?: (width: number) => void;
  /** The width the grip was let go at, to keep. */
  readonly onRailResizeEnd?: (width: number) => void;
  /** Every click inside the shell, heard after its target's own handlers. */
  readonly onClick?: (event: MouseEvent<HTMLDivElement>) => void;
  readonly children: ReactNode;
}

export function Shell(props: ShellProps): ReactElement {
  const ready = useReadyAfterFirstLayout();
  const [railDragging, setRailDragging] = useState(false);
  const collapsed = props.railCollapsed ?? false;
  const railWidth = props.railWidth ?? RAIL_DEFAULT;
  const track = {
    '--rail-w': `${String(collapsed ? RAIL_STRIP : railWidth)}px`,
    ...(props.dockWidth === undefined ? {} : { '--dock-w': `${String(props.dockWidth)}px` }),
    ...(props.dockSheetHeight === undefined
      ? {}
      : { '--dock-sheet-h': `${String(props.dockSheetHeight)}px` }),
  } as CSSProperties;
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- heard, not handled: each door is a button or a link
    <div
      className="shell"
      data-face={props.face}
      data-rail={collapsed ? 'collapsed' : 'expanded'}
      style={track}
      onClick={props.onClick}
      {...(ready ? { 'data-dock-ready': '' } : {})}
      {...(railDragging ? { 'data-rail-dragging': '' } : {})}
    >
      <nav className="rail" aria-label="Sections">
        {/* First in the rail, where it is drawn, and it says whether the rail
            is open (the mockup appended it last and said neither). */}
        {props.onRailFold === undefined ? null : (
          <button
            type="button"
            className="railfold"
            aria-label={collapsed ? 'Expand the menu' : 'Collapse the menu'}
            aria-expanded={!collapsed}
            onClick={props.onRailFold}
          >
            <span aria-hidden="true">{collapsed ? '»' : '«'}</span>
          </button>
        )}
        <div className="rail__brand">
          {/* The wordmark is a mask over an SVG in the pinned estate. No asset
              ships here until the icon-and-font rights question is resolved
              (#32), so the brand is its own words. */}
          <span className="rail__hub">Ops Astro</span>
        </div>
        <div className="rail__group">
          {props.rail.map((entry) => (
            <a
              key={entry.id}
              className="rail__item"
              href={entry.href}
              // The pinned task page has no rail row, so its own audit reports
              // "no aria-current set" on the single most important screen in
              // the slice. Here every route's rail entry is derived from the
              // same descriptor list the router resolves, so the mark cannot go
              // missing without the route going missing too.
              {...(entry.href === props.here ? { 'aria-current': 'page' as const } : {})}
              // In the strip the name shows on hover; the label stays the
              // item's accessible name, hidden only from sight.
              {...(collapsed ? { title: entry.label } : {})}
            >
              {/* The icon slot carries the section's initial until the kit's
                  icon set lands (MP-1-2, R55). */}
              <span className="rail__glyph" aria-hidden="true">
                {entry.label.slice(0, 1)}
              </span>
              <span className="rail__label">{entry.label}</span>
            </a>
          ))}
        </div>
        {collapsed || props.onRailResize === undefined ? null : (
          <EdgeGrip
            edge="right"
            className="railgrip"
            label="Menu width"
            value={railWidth}
            min={RAIL_MIN}
            max={RAIL_MAX}
            reset={RAIL_DEFAULT}
            per={1}
            onDragging={setRailDragging}
            onChange={props.onRailResize}
            onCommit={props.onRailResizeEnd}
          />
        )}
      </nav>

      <main className="main">
        <header className="topbar">
          <div className="topbar__title">
            <h1 className="t-title">{props.title}</h1>
          </div>
          {props.meta === undefined ? null : <div className="topbar__meta">{props.meta}</div>}
        </header>
        <div className="content">{props.children}</div>
      </main>

      {/* The dock is the way in to a panel at every width. The rail rotates
          below 900; it does not disappear, and there is no topbar fallback —
          at the pinned revision that control is display:none at every width. */}
      {props.dock === null ? null : <Dock {...props.dock} />}
    </div>
  );
}
