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
  /**
   * The build identifier, drawn at the foot of the rail (S0-1, line C2). Null
   * is a build that carries none, and the rail says so rather than going blank.
   */
  readonly build: string | null;
  /**
   * The signed-in person and the way out, drawn in the app strip where the
   * mockup draws the people on the page. Absent when nobody is signed in, and
   * then there is no app strip: it is the signed-in person's chrome.
   */
  readonly person?: ReactNode;
  /**
   * The section's tab row (DS-COMP-2), drawn between the app strip and the
   * page header as the mockup draws it. Absent on a page without siblings.
   */
  readonly tabs?: ReactNode;
  /** Whether the rail's drawer is open at 900 and below. The drawer is shut when absent. */
  readonly navOpen?: boolean;
  /** Opens or shuts the rail's drawer; without it no hamburger is drawn. */
  readonly onNav?: (open: boolean) => void;
  /** A step back or forward through this tab's pages; without them the pair is not drawn. */
  readonly onBack?: () => void;
  readonly onForward?: () => void;
  readonly children: ReactNode;
}

/**
 * The app strip (DS-COMP-1): history, search, the face switch and the timer.
 * Search, the client face and the timer are not built yet, so each is drawn in
 * the kit's not-yet-built treatment (PLACEHOLDERS.md SH-14, SH-16, SH-17):
 * disabled, its reason in a tooltip. Presence is left out until live presence
 * exists (SH-15, R30).
 */
function AppStrip(props: ShellProps): ReactElement {
  return (
    <header className="appbar">
      {props.onBack === undefined || props.onForward === undefined ? null : (
        <div className="appbar__nav">
          <button type="button" aria-label="Back" onClick={props.onBack}>
            <Icon name="angle-small-left" size="sm" />
          </button>
          <button type="button" aria-label="Forward" onClick={props.onForward}>
            <Icon name="angle-small-right" size="sm" />
          </button>
        </div>
      )}
      {props.face === 'agency' ? (
        <button
          className="appbar__search"
          type="button"
          disabled
          title="Search is not available yet"
        >
          <Icon name="search" size="sm" />
          <span>Search…</span>
          <span className="appbar__kbd" aria-hidden="true">
            ⌘K
          </span>
        </button>
      ) : null}
      <div className="appbar__r">
        {props.person}
        <FaceSwitch face={props.face} />
        {props.face === 'agency' ? (
          <button
            className="appbar__timer"
            type="button"
            disabled
            title="Time tracking is not available yet"
          >
            <Icon name="play" size="sm" />
            <span>Start timer</span>
          </button>
        ) : null}
      </div>
    </header>
  );
}

/** The face switch (SH-16): the face on is pressed; the other is not built yet. */
function FaceSwitch(props: { readonly face: ShellProps['face'] }): ReactElement {
  const faces = [
    { face: 'agency', label: 'Agency', reason: 'The agency view is not available here yet' },
    { face: 'client', label: 'Client', reason: 'The client view is not available yet' },
  ] as const;
  return (
    <div className="segmented appbar__switch" role="group" aria-label="View">
      {faces.map((entry) => (
        <button
          key={entry.face}
          className="segmented__opt"
          type="button"
          aria-pressed={props.face === entry.face}
          disabled={props.face !== entry.face}
          title={props.face === entry.face ? undefined : entry.reason}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

export function Shell(props: ShellProps): ReactElement {
  return (
    <div
      className="shell"
      data-face={props.face}
      data-dock={props.seated ? 'seated' : 'floating'}
      data-nav={props.navOpen === true ? 'open' : undefined}
    >
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
        {/* The version stamp's one fixed place. The browser rows read
            `data-build` here and match it against the served build. */}
        <p className="rail__build" data-build={props.build ?? ''}>
          {props.build === null ? 'Build not stamped' : `Build ${props.build}`}
        </p>
      </nav>

      {/* The drawer's backdrop, at 900 and below: a press on it shuts the drawer. */}
      {props.navOpen === true && props.onNav !== undefined ? (
        <div
          className="navbackdrop"
          aria-hidden="true"
          onClick={() => {
            props.onNav?.(false);
          }}
        />
      ) : null}

      <main className="main">
        {/* The app strip, the tab row and the page header travel together and
            stick as one. */}
        <div className="chrome">
          {props.person === undefined ? null : <AppStrip {...props} />}
          {props.tabs}
          <header className="topbar">
            {props.onNav === undefined ? null : (
              <button
                className="navtoggle"
                type="button"
                aria-label={props.navOpen === true ? 'Close navigation' : 'Open navigation'}
                aria-expanded={props.navOpen === true}
                onClick={() => {
                  props.onNav?.(props.navOpen !== true);
                }}
              >
                <span className="navtoggle__bars" aria-hidden="true" />
              </button>
            )}
            <div className="topbar__title">
              <h1 className="t-title">{props.title}</h1>
            </div>
            {props.meta === undefined ? null : <div className="topbar__meta">{props.meta}</div>}
          </header>
        </div>
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
            aria-label={`${tab.open ? 'Close' : 'Open'} ${tab.label}`}
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
          </button>
        ))}
        {props.panel}
      </div>
    </div>
  );
}
