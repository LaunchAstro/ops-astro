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
// drawer's focus trap and the one Escape.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useMark } from './mark.ts';
import { Chevron, Freshness, TabRow, type FreshnessState, type TabEntry } from './Frame.tsx';

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
}

export interface DockTab {
  readonly id: string;
  readonly label: string;
  readonly open: boolean;
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
  readonly freshness?: FreshnessState | null;
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
  readonly children: ReactNode;
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The in-app address a click on a link asked for, or null to leave it to the browser. */
function inAppAddress(event: MouseEvent<HTMLElement>): string | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const anchor = (event.target as Element | null)?.closest?.('a[href]') ?? null;
  if (anchor === null) return null;
  const target = anchor.getAttribute('target');
  if ((target !== null && target !== '_self') || anchor.hasAttribute('download')) return null;
  const href = anchor.getAttribute('href') ?? '';
  return href.startsWith('/') && !href.startsWith('//') ? href : null;
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

  // Focus moves into the drawer on open and back to its toggle on close.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) {
      const rail = railRef.current;
      const into =
        rail?.querySelector<HTMLElement>('[data-lit]') ??
        rail?.querySelector<HTMLElement>(FOCUSABLE);
      into?.focus();
    }
    if (!open && wasOpen.current) toggleRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  // One Escape closes the drawer and nothing under it.
  useEffect(() => {
    if (!open || onToggle === undefined) return;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onToggle(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onToggle]);

  // While the drawer is open, Tab and Shift+Tab stay inside it.
  const trap = (event: KeyboardEvent<HTMLElement>): void => {
    if (!open || event.key !== 'Tab') return;
    const inside = [...(railRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const first = inside[0];
    const last = inside.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

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
          {/* The wordmark is a mask over an SVG in the pinned estate. No asset
              ships here until the icon-and-font rights question is resolved
              (#32), so the brand is its own words. */}
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
          {props.tabs == null ? null : (
            <TabRow key={props.tabs.id} label={props.tabs.label} tabs={props.tabs.entries} />
          )}
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
              {props.freshness == null ? null : <Freshness state={props.freshness} />}
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
            aria-label={`${tab.open ? 'Close' : 'Open'} ${tab.label}`}
            onClick={() => {
              props.onDockTab(tab.id);
            }}
          >
            {/* The icon slot. It carries the panel's initial until an icon set
                with redistribution rights is resolved, rather than an emoji,
                which the design system forbids outright. */}
            <span aria-hidden="true">{tab.label.slice(0, 1)}</span>
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
