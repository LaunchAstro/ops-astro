// SPDX-License-Identifier: AGPL-3.0-only
//
// S6: the shell around all of them. Not a route.
//
// Three tracks on the agency face above 900 pixels — rail, content, dock — and
// one below it, where the rail becomes a modal drawer and the dock's tab strip
// rotates onto the bottom edge. The third track's width is a variable the shell
// writes and nothing else does.
//
// The content column opens with the chrome: the app strip, the section's tab
// row and the page header, one block that is sticky above 900 and scrolls away
// at 900 and below (MP-2-7).
//
// This component holds no session state. Panel open state, whether the drawer
// is open and the current face belong to `apps/web`, because `packages/ui`
// owns visual controls and layout and may not own a session [ui-reference
// CONTRACT.md:305 rule 3]. It owns their motion and focus: the railmark, the
// drawer's focus trap and the one Escape (drawer.ts).

import {
  useCallback,
  useId,
  useRef,
  type CSSProperties,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { BrandMark } from '../primitives/BrandMark.tsx';
import { Icon, type GlyphName } from '../primitives/Icon.tsx';
import { useDrawerFocus } from './drawer.ts';
import { inAppAddress } from './gesture.ts';
import { useMark } from './mark.ts';
import { FreshnessMarker, type Freshness } from '../kit/treatments.tsx';
import { Chevron, TabRow, type TabEntry } from './TabRow.tsx';

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
  /** The app strip (MP-2-5), placed first in the chrome. */
  readonly strip?: ReactNode;
  /** The current section's tab row, or null where the section has one page. */
  readonly tabs?: {
    readonly id: string;
    readonly label: string;
    readonly entries: readonly TabEntry[];
  } | null;
  /** The header's freshness marker (CS-1.1), or null to draw none. */
  readonly freshness?: Freshness | null;
  /** The narrow drawer (MP-2-8): open or not is the application's state. */
  readonly nav?: { readonly open: boolean; readonly onToggle: (open: boolean) => void };
  /**
   * An in-app address a plain click on a link inside the shell asked for. The
   * link is left to the browser for a modified click, another target or
   * another origin.
   */
  readonly onNavigate?: (href: string) => void;
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
  readonly children: ReactNode;
}

export function Shell(props: ShellProps): ReactElement {
  const railId = useId();
  const open = props.nav?.open ?? false;
  const onToggle = props.nav?.onToggle;
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);

  const sections = props.rail.filter((entry) => entry.kind !== 'back');
  const back = props.rail.find((entry) => entry.kind === 'back');
  const litId = sections.find((entry) => entry.lit === true)?.id ?? null;
  const measure = useCallback(
    (item: HTMLElement) => ({ y: item.offsetTop, h: item.offsetHeight }),
    [],
  );
  // The railmark: snapped onto the lit item on load, sliding over 220ms once
  // the lit item has changed, hidden where nothing is lit.
  const mark = useMark(litId, measure, '[data-lit]');

  const trap = useDrawerFocus(open, onToggle, railRef, toggleRef);

  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (props.onNavigate === undefined) return;
    const href = inAppAddress(event);
    if (href === null) return;
    event.preventDefault();
    props.onNavigate(href);
  };

  const markStyle = {
    '--railmark-y': `${mark.box?.y ?? 0}px`,
    '--railmark-h': `${mark.box?.h ?? 0}px`,
  } as CSSProperties;

  return (
    <div
      className="shell"
      data-face={props.face}
      data-dock={props.seated ? 'seated' : 'floating'}
      {...(open ? { 'data-nav': 'open' } : {})}
      onClick={onClick}
    >
      <nav
        className="rail"
        id={railId}
        aria-label="Sections"
        ref={railRef}
        onKeyDown={trap}
        {...(open ? { 'aria-modal': true, role: 'dialog' } : {})}
      >
        <div className="rail__brand">
          <BrandMark variant="wordmark" />
          <span className="rail__hub">Ops Astro</span>
          {open && onToggle !== undefined ? (
            <button
              className="navclose"
              type="button"
              aria-expanded="true"
              aria-controls={railId}
              aria-label="Close the menu"
              onClick={() => {
                onToggle(false);
              }}
            >
              <Chevron towards="start" />
            </button>
          ) : null}
        </div>
        {back === undefined ? null : (
          <div className="rail__backrow">
            <a className="btn btn--primary btn--sm rail__back" href={back.href} title={back.label}>
              <Chevron towards="start" />
              <span className="rail__label">{back.label}</span>
            </a>
          </div>
        )}
        <div className="rail__group" ref={mark.holder}>
          {sections.map((entry) => (
            <a
              key={entry.id}
              className="rail__item"
              href={entry.href}
              // The current section is lit on every address, a task or a
              // booking page included: `page` where the section's own address
              // is open, `location` where one of its pages is.
              {...(entry.lit === true
                ? {
                    'data-lit': '',
                    'aria-current':
                      entry.exact === true ? ('page' as const) : ('location' as const),
                  }
                : {})}
            >
              {entry.icon === undefined ? null : (
                <span className="rail__icon" data-glyph={entry.icon} aria-hidden="true">
                  <Icon name={entry.icon} size="sm" />
                </span>
              )}
              <span>{entry.label}</span>
            </a>
          ))}
          <span
            className="railmark"
            aria-hidden="true"
            hidden={mark.box === null}
            style={markStyle}
            {...(mark.placing ? { 'data-placing': '' } : {})}
          />
        </div>
        {/* The version stamp's one fixed place. The browser rows read
            `data-build` here and match it against the served build. */}
        <p className="rail__build" data-build={props.build ?? ''}>
          {props.build === null ? 'Build not stamped' : `Build ${props.build}`}
        </p>
      </nav>
      {open && onToggle !== undefined ? (
        <div
          className="navbackdrop"
          aria-hidden="true"
          onClick={() => {
            onToggle(false);
          }}
        />
      ) : null}

      <main className="main" inert={open}>
        <div className="chrome">
          {props.strip}
          {props.tabs ? (
            <TabRow key={props.tabs.id} label={props.tabs.label} tabs={props.tabs.entries} />
          ) : null}
          <header className="topbar">
            {onToggle === undefined ? null : (
              <button
                className="navtoggle"
                type="button"
                ref={toggleRef}
                aria-expanded={open}
                aria-controls={railId}
                aria-label="Open the menu"
                onClick={() => {
                  onToggle(!open);
                }}
              >
                <span />
                <span />
                <span />
              </button>
            )}
            <div className="topbar__title">
              <h1 className="t-title">{props.title}</h1>
            </div>
            <div className="topbar__meta">
              {props.freshness ? <FreshnessMarker freshness={props.freshness} /> : null}
              {props.meta}
            </div>
          </header>
        </div>
        <div className="content">{props.children}</div>
      </main>

      {/* The dock is the way in to a panel at every width. The rail rotates
          below 900; it does not disappear, and there is no topbar fallback —
          at the pinned revision that control is display:none at every width. */}
      <div className="dock__rail" role="group" aria-label="Side panels" inert={open}>
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
