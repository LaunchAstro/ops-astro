// SPDX-License-Identifier: AGPL-3.0-only
//
// S6: the shell around all of them. Not a route.
//
// Three tracks on the agency face above 900 pixels — rail, content, dock — and
// one below it, where the rail becomes a drawer and the dock's tab strip
// rotates onto the bottom edge. The third track's width is a variable the shell
// writes and nothing else does.
//
// This component holds no session state. Panel open state, the drawer and the
// current face belong to `apps/web`, because `packages/ui` owns visual controls
// and layout and may not own a session [ui-reference CONTRACT.md:305 rule 3].

import type { CSSProperties, MouseEvent, ReactElement, ReactNode } from 'react';
import { Dock, useReadyAfterFirstLayout, type DockProps } from './Dock.tsx';

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
  /** Every click inside the shell, heard after its target's own handlers. */
  readonly onClick?: (event: MouseEvent<HTMLDivElement>) => void;
  readonly children: ReactNode;
}

export function Shell(props: ShellProps): ReactElement {
  const ready = useReadyAfterFirstLayout();
  const track =
    props.dockWidth === undefined
      ? undefined
      : ({ '--dock-w': `${String(props.dockWidth)}px` } as CSSProperties);
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- heard, not handled: each door is a button or a link
    <div
      className="shell"
      data-face={props.face}
      style={track}
      onClick={props.onClick}
      {...(ready ? { 'data-dock-ready': '' } : {})}
    >
      <nav className="rail" aria-label="Sections">
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
            >
              <span>{entry.label}</span>
            </a>
          ))}
        </div>
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
