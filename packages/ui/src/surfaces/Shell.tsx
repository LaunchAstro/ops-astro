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

import type { ReactElement, ReactNode } from 'react';
import { BrandMark } from '../primitives/BrandMark.tsx';
import { Icon, type GlyphName } from '../primitives/Icon.tsx';

export interface RailEntry {
  /** Namespace-qualified. Sixteen bare identifiers collide in the corpus. */
  readonly id: string;
  readonly label: string;
  readonly href: string;
}

export interface DockTab {
  readonly id: string;
  readonly label: string;
  readonly open: boolean;
  /** The panel's glyph, as the mockup registers each panel with one; the grid glyph when none is named. */
  readonly icon?: GlyphName;
  /** What is waiting in the panel, painted with the first frame; none at zero. */
  readonly count?: number;
}

export interface ShellProps {
  readonly face: 'agency' | 'client';
  readonly rail: readonly RailEntry[];
  /** The address of the page being drawn, so the rail can mark it. */
  readonly here: string;
  readonly title: string;
  readonly meta?: ReactNode;
  readonly dock: readonly DockTab[];
  readonly onDockTab: (id: string) => void;
  /** Whether the open panel is seated as a grid track or floating over. */
  readonly seated: boolean;
  readonly panel?: ReactNode;
  readonly children: ReactNode;
}

export function Shell(props: ShellProps): ReactElement {
  return (
    <div className="shell" data-face={props.face} data-dock={props.seated ? 'seated' : 'floating'}>
      <nav className="rail" aria-label="Sections">
        <div className="rail__brand">
          <BrandMark variant="wordmark" />
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
      <div className="dock__rail" role="group" aria-label="Side panels">
        {props.dock.map((tab) => (
          <button
            key={tab.id}
            className="dock__tab"
            type="button"
            aria-expanded={tab.open}
            aria-label={`${tab.open ? 'Close' : 'Open'} ${tab.label}${
              (tab.count ?? 0) > 0 ? `, ${String(tab.count)} unread` : ''
            }`}
            onClick={() => {
              props.onDockTab(tab.id);
            }}
          >
            {/* The icon slot: the panel's glyph from the licensed set (MP-1-2),
                never an initial or an emoji. Decoration: the button's label
                names the panel. */}
            <Icon name={tab.icon ?? 'apps'} />
            {/* The callout names the tab on hover and focus. The button's
                label already says it, so the callout is hidden from it. */}
            <span className="dock__tablabel" aria-hidden="true">
              {tab.label}
            </span>
            {(tab.count ?? 0) > 0 ? (
              <span className="cbadge dock__count" aria-hidden="true">
                {tab.count}
              </span>
            ) : null}
          </button>
        ))}
        {props.panel}
      </div>
    </div>
  );
}
