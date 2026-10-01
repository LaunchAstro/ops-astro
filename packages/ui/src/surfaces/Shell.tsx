// SPDX-License-Identifier: AGPL-3.0-only
//
// S6: the shell around all of them. Not a route.
//
// Three tracks on the agency face above 900 pixels — rail, content, dock — and
// one below it, where the rail becomes a modal drawer and the dock's tab strip
// rotates onto the bottom edge. The third track's width is a variable the shell
// writes and nothing else does.
//
// The rail folds to a 56px strip of glyphs, each with its section's name on
// hover, and its right edge drags it from 170 to 400 (MP-2-3). The person's
// choice is the application's to hold and to keep; what the shell draws on
// its first render is what it is handed, so nothing jumps before paint.
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
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { BrandMark } from '../primitives/BrandMark.tsx';
import { Dock, useReadyAfterFirstLayout, type DockProps } from './Dock.tsx';
import { useDrawerFocus } from './drawer.ts';
import { inAppAddress } from './gesture.ts';
import { useMark } from './mark.ts';
import { FreshnessMarker, type Freshness } from '../kit/treatments.tsx';
import { Chevron, TabRow, type TabEntry } from './TabRow.tsx';

import {
  RAIL_DEFAULT,
  RAIL_STRIP,
  RailFold,
  RailGrip,
  RailItem,
  type RailEntry,
} from './RailParts.tsx';

export { RAIL_DEFAULT, RAIL_MAX, RAIL_MIN, RAIL_STRIP, type RailEntry } from './RailParts.tsx';

export interface ShellProps {
  readonly face: 'agency' | 'client';
  readonly rail: readonly RailEntry[];
  /** The address of the page being drawn, so the rail can mark it. */
  readonly here: string;
  readonly title: string;
  readonly meta?: ReactNode;
  /** The dock, or null where there is none: signed out, and on the client face (R17). */
  readonly dock: DockProps | null;
  /** The dock task panel (MP-4-8), beside the dock until the dock draws it as its `task` panel. */
  readonly taskPanel?: ReactNode;
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
  /**
   * The build identifier, drawn at the foot of the rail (S0-1, line C2). Null
   * is a build that carries none, and the rail says so rather than going blank.
   */
  readonly build: string | null;
  readonly children: ReactNode;
}

export function Shell(props: ShellProps): ReactElement {
  const ready = useReadyAfterFirstLayout();
  const [railDragging, setRailDragging] = useState(false);
  const collapsed = props.railCollapsed ?? false;
  const railWidth = props.railWidth ?? RAIL_DEFAULT;
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

  // The dock's doors hear the click first; a link nobody took is then
  // followed in the app rather than reloading the page.
  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    props.onClick?.(event);
    if (props.onNavigate === undefined) return;
    const href = inAppAddress(event);
    if (href === null) return;
    event.preventDefault();
    props.onNavigate(href);
  };

  const style = {
    '--rail-w': `${String(collapsed ? RAIL_STRIP : railWidth)}px`,
    ...(props.dockWidth === undefined ? {} : { '--dock-w': `${String(props.dockWidth)}px` }),
    ...(props.dockSheetHeight === undefined
      ? {}
      : { '--dock-sheet-h': `${String(props.dockSheetHeight)}px` }),
  } as CSSProperties;
  const markStyle = {
    '--railmark-y': `${mark.box?.y ?? 0}px`,
    '--railmark-h': `${mark.box?.h ?? 0}px`,
  } as CSSProperties;

  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- heard, not handled: each door is a button or a link
    <div
      className="shell"
      data-face={props.face}
      data-rail={collapsed ? 'collapsed' : 'expanded'}
      data-dock={(props.dockWidth ?? 0) > 0 ? 'seated' : 'floating'}
      style={style}
      onClick={onClick}
      {...(open ? { 'data-nav': 'open' } : {})}
      {...(ready ? { 'data-dock-ready': '' } : {})}
      {...(railDragging ? { 'data-rail-dragging': '' } : {})}
    >
      <nav
        className="rail"
        id={railId}
        aria-label="Sections"
        ref={railRef}
        onKeyDown={trap}
        {...(open ? { 'aria-modal': true, role: 'dialog' } : {})}
      >
        {/* The fold and the grip are the wide rail's: the narrow drawer has
            neither, so its focus trap holds only what it draws. */}
        {props.onRailFold === undefined || open ? null : (
          <RailFold collapsed={collapsed} onFold={props.onRailFold} />
        )}
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
            <RailItem key={entry.id} entry={entry} collapsed={collapsed} />
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
        {collapsed || open || props.onRailResize === undefined ? null : (
          <RailGrip
            width={railWidth}
            onDragging={setRailDragging}
            onResize={props.onRailResize}
            onResizeEnd={props.onRailResizeEnd}
          />
        )}
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
      {props.dock === null ? null : <Dock {...props.dock} inert={open} />}
      {props.dock === null ? null : props.taskPanel}
    </div>
  );
}
